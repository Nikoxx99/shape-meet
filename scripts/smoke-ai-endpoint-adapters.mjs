import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const python =
  process.env.SHAPE_AI_SMOKE_PYTHON ?? process.env.SHAPE_AI_PYTHON ?? "python3";
const sidecarPort = await getFreePort();
const videoPort = await getFreePort();
const audioPort = await getFreePort();
const modelPort = await getFreePort();
const sidecarUrl = `http://127.0.0.1:${sidecarPort}`;
const modelUrl = `http://127.0.0.1:${modelPort}`;
const processorScript = fileURLToPath(
  new URL(
    "../apps/ai-sidecar/processors/shape_processor_command.py",
    import.meta.url,
  ),
);
const seen = { face: 0, background: 0, voice: 0 };

const modelServer = createModelServer();
modelServer.listen(modelPort, "127.0.0.1");
await once(modelServer, "listening");

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
      SHAPE_FACE_ENGINE: "facefusion-http",
      SHAPE_BACKGROUND_ENGINE: "backgroundmattingv2-http",
      SHAPE_VOICE_ENGINE: "vcclient000-http",
      SHAPE_VIDEO_PROCESSOR_COMMAND: processorCommand("video", videoPort),
      SHAPE_VIDEO_PROCESSOR_ENDPOINT: `http://127.0.0.1:${videoPort}/process-frame`,
      SHAPE_VIDEO_PROCESSOR_HEALTH_URL: `http://127.0.0.1:${videoPort}/health`,
      SHAPE_FACE_ENDPOINT: `${modelUrl}/face`,
      SHAPE_BACKGROUND_ENDPOINT: `${modelUrl}/background`,
      SHAPE_AUDIO_PROCESSOR_COMMAND: processorCommand("audio", audioPort),
      SHAPE_AUDIO_PROCESSOR_ENDPOINT: `http://127.0.0.1:${audioPort}/process-audio`,
      SHAPE_AUDIO_PROCESSOR_HEALTH_URL: `http://127.0.0.1:${audioPort}/health`,
      SHAPE_VOICE_ENDPOINT: `${modelUrl}/voice`,
      SHAPE_PROCESSOR_TIMEOUT_SECS: "3",
      SHAPE_MODEL_COMMAND_TIMEOUT_SECS: "3",
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
  await waitForProcessor(`http://127.0.0.1:${videoPort}/health`, "video");
  await waitForProcessor(`http://127.0.0.1:${audioPort}/health`, "audio");

  const preflight = await request("/preflight", {
    method: "POST",
    body: sessionPayload(),
  });
  assert(preflight.status === 200, `preflight returned ${preflight.status}`);
  assert(
    preflight.data.preflight?.status === "passed",
    "preflight did not pass with endpoint adapters",
  );
  assert(
    preflight.data.preflight?.checks?.some(
      (check) =>
        check.id === "video" &&
        check.processor === "shape-video-model-chain:face+background",
    ),
    "preflight did not use face/background endpoint chain",
  );
  assert(
    preflight.data.preflight?.checks?.some(
      (check) =>
        check.id === "audio" &&
        check.processor === "shape-voice-endpoint-adapter",
    ),
    "preflight did not use voice endpoint",
  );

  const session = await request("/sessions", {
    method: "POST",
    body: sessionPayload(),
  });
  assert(session.status === 201, `session create returned ${session.status}`);
  const sessionId = session.data.session?.id;
  assert(sessionId, "session id missing");

  const frame = await request(
    `/sessions/${encodeURIComponent(sessionId)}/frames`,
    {
      method: "POST",
      body: {
        sequence: 82,
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
    frame.data.frame?.processor === "shape-video-model-chain:face+background",
    "frame did not use face/background endpoint chain",
  );
  assert(
    frame.data.frame?.status === "processed",
    "frame endpoint chain did not process output",
  );

  const audio = await request(
    `/sessions/${encodeURIComponent(sessionId)}/audio`,
    {
      method: "POST",
      body: {
        sequence: 83,
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
    audio.data.audio?.processor === "shape-voice-endpoint-adapter",
    "audio did not use voice endpoint",
  );
  assert(
    audio.data.audio?.status === "processed",
    "voice endpoint did not process output",
  );

  assert(seen.face >= 2, `face endpoint calls too low: ${seen.face}`);
  assert(
    seen.background >= 2,
    `background endpoint calls too low: ${seen.background}`,
  );
  assert(seen.voice >= 2, `voice endpoint calls too low: ${seen.voice}`);

  await request(`/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
  console.log("endpoint adapter smoke ok");
} finally {
  sidecar.kill();
  modelServer.close();
}

function createModelServer() {
  return createHttpServer((request, response) => {
    const path = request.url?.split("?", 1)[0] ?? "/";
    if (request.method !== "POST") {
      writeJson(response, 404, { error: "not_found" });
      return;
    }

    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");

      if (path === "/face" || path === "/background") {
        const stage = path.slice(1);
        seen[stage] += 1;
        assert(body.stage === stage, `${stage} endpoint received wrong stage`);
        assert(body.frame?.outputPath, `${stage} endpoint missing outputPath`);
        writeJson(response, 200, {
          status: "processed",
          frame: {
            dataUrl: body.frame?.dataUrl ?? body.frame?.frameDataUrl,
            width: body.target?.width ?? 1280,
            height: body.target?.height ?? 720,
            format: "image/jpeg",
          },
          metrics: {
            latencyMs: 3,
            fps: body.target?.fps ?? 30,
            vramMb: 24576,
            resolution: `${body.target?.width ?? 1280}x${body.target?.height ?? 720}`,
          },
          warnings: [],
        });
        return;
      }

      if (path === "/voice") {
        seen.voice += 1;
        assert(body.stage === "voice", "voice endpoint received wrong stage");
        assert(body.audio?.outputPath, "voice endpoint missing outputPath");
        writeJson(response, 200, {
          status: "processed",
          audio: {
            audioDataBase64: body.audio?.audioDataBase64,
            sampleRate: body.audio?.sampleRate ?? 48000,
            channels: body.audio?.channels ?? 1,
            format: body.audio?.format ?? "pcm_f32le",
          },
          metrics: { latencyMs: 2, inputBytes: 4 },
          warnings: [],
        });
        return;
      }

      writeJson(response, 404, { error: "not_found" });
    });
  });
}

function writeJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function processorCommand(kind, port) {
  return `${JSON.stringify(python)} ${JSON.stringify(processorScript)} --kind ${kind} --host 127.0.0.1 --port ${port}`;
}

function sessionPayload() {
  return {
    meetingCode: "SM-909-010",
    participantId: "host_endpoint",
    identityId: "identity_endpoint",
    identityKind: "PHOTO_IDENTITY",
    identityVersion: "v1",
    identityArtifactUri: "file:///tmp/identity-endpoint.jpg",
    identityCachedArtifactUri: "file:///tmp/identity-endpoint.jpg",
    identityLocalArtifactPath: "/tmp/identity-endpoint.jpg",
    identityArtifactSha256: "abc123",
    identityArtifactSizeBytes: 123,
    faceEnabled: true,
    backgroundEnabled: true,
    backgroundCleanPlateDataUrl: "data:image/jpeg;base64,BBBB",
    backgroundCleanPlateCapturedAt: new Date().toISOString(),
    backgroundCleanPlateWidth: 1280,
    backgroundCleanPlateHeight: 720,
    backgroundCleanPlateCameraDeviceId: "camera_endpoint",
    voiceEnabled: true,
    targetWidth: 1280,
    targetHeight: 720,
    targetFps: 30,
    frameDataUrl: "data:image/jpeg;base64,AAAA",
    audioDataBase64: "AAAA",
    audioSampleRate: 48000,
  };
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
  for (let attempt = 1; attempt <= 50; attempt += 1) {
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

async function waitForProcessor(url, label) {
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    try {
      const response = await fetch(url);
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.status === "ready") return;
    } catch {
      // keep waiting
    }

    await sleep(250);
  }

  fail(`${label} endpoint processor did not become ready`);
}

async function getFreePort() {
  const server = createNetServer();
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

function assert(condition, message) {
  if (!condition) fail(message);
}

function fail(message) {
  console.error(message);
  if (stdout.trim()) console.error(`sidecar stdout:\n${stdout.trim()}`);
  if (stderr.trim()) console.error(`sidecar stderr:\n${stderr.trim()}`);
  process.exit(1);
}
