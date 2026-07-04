import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";

const python =
  process.env.SHAPE_AI_SMOKE_PYTHON ?? process.env.SHAPE_AI_PYTHON ?? "python3";
const sidecarPort =
  Number(process.env.SHAPE_AI_SMOKE_PORT ?? 0) || (await getFreePort());
const sidecarUrl = `http://127.0.0.1:${sidecarPort}`;
const requests = { video: [], audio: [] };

const videoProcessor = await startJsonProcessor("video", (payload) => {
  requests.video.push(payload);
  assert(payload.session?.id, "video processor did not receive session.id");
  assert(
    payload.identity?.id === "identity_smoke",
    "video processor did not receive identity manifest",
  );
  assert(
    payload.enabled?.face === true,
    "video processor did not receive face=true",
  );
  assert(
    payload.enabled?.background === true,
    "video processor did not receive background=true",
  );
  assert(
    payload.background?.cleanPlate?.dataUrl?.startsWith("data:image/"),
    "video processor did not receive clean plate data URL",
  );
  assert(
    payload.background?.cleanPlate?.width === 1280,
    "video processor did not receive clean plate width",
  );
  assert(
    payload.frame?.frameDataUrl?.startsWith("data:image/"),
    "video processor did not receive a frame data URL",
  );

  return {
    frame: {
      sequence: payload.frame.sequence,
      status: "processed",
      processor: "mock-facefusion-backgroundmattingv2",
      frame: {
        dataUrl: payload.frame.frameDataUrl,
        width: payload.target.width,
        height: payload.target.height,
        format: "image/jpeg",
      },
      metrics: {
        fps: payload.target.fps,
        latencyMs: 11,
        framesProcessed: 1,
        vramMb: 1234,
        resolution: `${payload.target.width}x${payload.target.height}`,
      },
      warnings: ["mock_video_processor"],
    },
  };
});

const audioProcessor = await startJsonProcessor("audio", (payload) => {
  requests.audio.push(payload);
  assert(payload.session?.id, "audio processor did not receive session.id");
  assert(
    payload.enabled?.voice === true,
    "audio processor did not receive voice=true",
  );
  assert(
    payload.audio?.audioDataBase64,
    "audio processor did not receive audio data",
  );

  return {
    audio: {
      sequence: payload.audio.sequence,
      status: "processed",
      processor: "mock-vcclient000",
      audio: {
        audioDataBase64: payload.audio.audioDataBase64,
        sampleRate: payload.audio.sampleRate,
        channels: payload.audio.channels,
        format: payload.audio.format,
      },
      metrics: {
        chunksProcessed: 1,
        latencyMs: 7,
        inputBytes: payload.audio.audioDataBase64.length,
      },
      warnings: ["mock_audio_processor"],
    },
  };
});

const sidecar = spawn(
  python,
  [
    "apps/ai-sidecar/server.py",
    "--host",
    "127.0.0.1",
    "--port",
    String(sidecarPort),
  ],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SENTRY_DSN: "",
      SHAPE_AI_MODE: "adapter-contract",
      SHAPE_FACE_ENGINE: "facefusion",
      SHAPE_BACKGROUND_ENGINE: "backgroundmattingv2",
      SHAPE_VOICE_ENGINE: "vcclient000",
      SHAPE_VIDEO_PROCESSOR_ENDPOINT: videoProcessor.url,
      SHAPE_AUDIO_PROCESSOR_ENDPOINT: audioProcessor.url,
      SHAPE_PROCESSOR_TIMEOUT_SECS: "2",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let stdout = "";
let stderr = "";
sidecar.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});
sidecar.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

try {
  await waitForSidecar();

  const health = await request("/health");
  assert(health.status === 200, `health returned ${health.status}`);
  assert(
    health.data.mode === "adapter-contract",
    "sidecar did not start in adapter-contract mode",
  );
  assert(
    health.data.diagnostics?.externalProcessors?.video === true,
    "video processor not reported as configured",
  );
  assert(
    health.data.diagnostics?.externalProcessors?.audio === true,
    "audio processor not reported as configured",
  );
  console.log("health ok: adapter-contract");

  const session = await request("/sessions", {
    method: "POST",
    body: {
      meetingCode: "SM-123-456",
      participantId: "host_smoke",
      identityId: "identity_smoke",
      identityKind: "PHOTO_IDENTITY",
      identityVersion: "v1",
      identityArtifactUri: "file:///tmp/identity-smoke.jpg",
      identityCachedArtifactUri: "file:///tmp/identity-smoke.jpg",
      identityLocalArtifactPath: "/tmp/identity-smoke.jpg",
      identityArtifactSha256: "abc123",
      identityArtifactSizeBytes: 123,
      faceEnabled: true,
      backgroundEnabled: true,
      backgroundCleanPlateDataUrl: "data:image/jpeg;base64,BBBB",
      backgroundCleanPlateCapturedAt: new Date().toISOString(),
      backgroundCleanPlateWidth: 1280,
      backgroundCleanPlateHeight: 720,
      backgroundCleanPlateCameraDeviceId: "camera_smoke",
      voiceEnabled: true,
      targetWidth: 1280,
      targetHeight: 720,
      targetFps: 30,
    },
  });
  assert(session.status === 201, `session create returned ${session.status}`);
  const sessionId = session.data.session?.id;
  assert(sessionId, "session id missing");
  console.log(`session ok: ${sessionId}`);

  const frame = await request(
    `/sessions/${encodeURIComponent(sessionId)}/frames`,
    {
      method: "POST",
      body: {
        sequence: 1,
        timestampMs: Date.now(),
        width: 1280,
        height: 720,
        frameDataUrl: "data:image/jpeg;base64,AAAA",
        effects: { face: true, background: true, voice: true },
      },
    },
  );
  assert(frame.status === 200, `frame process returned ${frame.status}`);
  assert(
    frame.data.frame?.processor === "mock-facefusion-backgroundmattingv2",
    "frame did not come from video mock processor",
  );
  console.log(`frame ok: ${frame.data.frame.processor}`);

  const audio = await request(
    `/sessions/${encodeURIComponent(sessionId)}/audio`,
    {
      method: "POST",
      body: {
        sequence: 1,
        timestampMs: Date.now(),
        sampleRate: 48000,
        channels: 1,
        format: "pcm_f32le",
        audioDataBase64: "AAAA",
      },
    },
  );
  assert(audio.status === 200, `audio process returned ${audio.status}`);
  assert(
    audio.data.audio?.processor === "mock-vcclient000",
    "audio did not come from audio mock processor",
  );
  console.log(`audio ok: ${audio.data.audio.processor}`);

  const status = await request(`/sessions/${encodeURIComponent(sessionId)}`);
  assert(status.status === 200, `session status returned ${status.status}`);
  assert(
    status.data.session?.adapterError === null,
    `unexpected adapter error: ${status.data.session?.adapterError}`,
  );
  assert(
    status.data.session?.metrics?.latencyMs === 11,
    "session metrics did not use video processor latency",
  );
  assert(
    status.data.session?.metrics?.vramMb === 1234,
    "session metrics did not use video processor VRAM",
  );
  assert(
    status.data.session?.lastProcessed?.video?.processor ===
      "mock-facefusion-backgroundmattingv2",
    "session did not expose last video processor",
  );
  assert(
    status.data.session?.lastProcessed?.audio?.processor === "mock-vcclient000",
    "session did not expose last audio processor",
  );
  assert(
    requests.video.length === 1,
    "video mock processor was not called exactly once",
  );
  assert(
    requests.audio.length === 1,
    "audio mock processor was not called exactly once",
  );

  const stopped = await request(`/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
  assert(stopped.status === 200, `session delete returned ${stopped.status}`);
  console.log("contract smoke ok");
} finally {
  sidecar.kill();
  await Promise.allSettled([videoProcessor.close(), audioProcessor.close()]);
}

async function request(path, options = {}) {
  const response = await fetch(`${sidecarUrl}${path}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 600) };
  }

  return { status: response.status, data };
}

async function waitForSidecar() {
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    if (sidecar.exitCode !== null) {
      fail(`sidecar exited early with ${sidecar.exitCode}`);
    }

    try {
      const health = await request("/health");
      if (health.status === 200) return;
    } catch {
      // keep waiting
    }

    await sleep(250);
  }

  fail("sidecar did not become ready");
}

async function startJsonProcessor(name, handler) {
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }

    try {
      const payload = JSON.parse(await readRequestBody(request));
      const result = handler(payload);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: `${name}_processor_failed`,
          message: error.message,
        }),
      );
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(
    address && typeof address === "object",
    `${name} processor did not bind a port`,
  );

  return {
    url: `http://127.0.0.1:${address.port}/${name}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function getFreePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : null;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  assert(port, "could not allocate a free port");
  return port;
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function fail(message) {
  console.error(message);
  if (stdout.trim()) console.error(`sidecar stdout:\n${stdout.trim()}`);
  if (stderr.trim()) console.error(`sidecar stderr:\n${stderr.trim()}`);
  process.exit(1);
}
