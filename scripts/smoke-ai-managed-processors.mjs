import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const python = process.env.SHAPE_AI_SMOKE_PYTHON ?? process.env.SHAPE_AI_PYTHON ?? "python3";
const sidecarPort = await getFreePort();
const videoPort = await getFreePort();
const audioPort = await getFreePort();
const sidecarUrl = `http://127.0.0.1:${sidecarPort}`;
const processorScript = fileURLToPath(new URL("./mock-ai-processor.mjs", import.meta.url));

const sidecar = spawn(python, ["apps/ai-sidecar/server.py", "--host", "127.0.0.1", "--port", String(sidecarPort)], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    SENTRY_DSN: "",
    SHAPE_AI_MODE: "adapter-contract",
    SHAPE_FACE_ENGINE: "facefusion",
    SHAPE_BACKGROUND_ENGINE: "backgroundmattingv2",
    SHAPE_VOICE_ENGINE: "vcclient000",
    SHAPE_VIDEO_PROCESSOR_COMMAND: commandForProcessor("video", videoPort),
    SHAPE_VIDEO_PROCESSOR_ENDPOINT: `http://127.0.0.1:${videoPort}/process-frame`,
    SHAPE_VIDEO_PROCESSOR_HEALTH_URL: `http://127.0.0.1:${videoPort}/health`,
    SHAPE_AUDIO_PROCESSOR_COMMAND: commandForProcessor("audio", audioPort),
    SHAPE_AUDIO_PROCESSOR_ENDPOINT: `http://127.0.0.1:${audioPort}/process-audio`,
    SHAPE_AUDIO_PROCESSOR_HEALTH_URL: `http://127.0.0.1:${audioPort}/health`,
    SHAPE_PROCESSOR_TIMEOUT_SECS: "2"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

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
  await waitForManagedProcessors();

  const diagnostics = await request("/diagnostics");
  assert(diagnostics.status === 200, `diagnostics returned ${diagnostics.status}`);
  const processors = diagnostics.data.diagnostics?.managedProcessors ?? [];
  assert(processors.some((processor) => processor.id === "video" && processor.status === "running"), "video processor is not managed/running");
  assert(processors.some((processor) => processor.id === "audio" && processor.status === "running"), "audio processor is not managed/running");
  console.log("managed processors ok");

  const session = await request("/sessions", {
    method: "POST",
    body: {
      meetingCode: "SM-654-321",
      participantId: "host_managed",
      identityId: "identity_managed",
      identityKind: "PHOTO_IDENTITY",
      identityVersion: "v1",
      identityArtifactUri: "file:///tmp/identity-managed.jpg",
      identityCachedArtifactUri: "file:///tmp/identity-managed.jpg",
      identityLocalArtifactPath: "/tmp/identity-managed.jpg",
      identityArtifactSha256: "abc123",
      identityArtifactSizeBytes: 123,
      faceEnabled: true,
      backgroundEnabled: true,
      backgroundCleanPlateDataUrl: "data:image/jpeg;base64,BBBB",
      backgroundCleanPlateCapturedAt: new Date().toISOString(),
      backgroundCleanPlateWidth: 1280,
      backgroundCleanPlateHeight: 720,
      backgroundCleanPlateCameraDeviceId: "camera_managed",
      voiceEnabled: true,
      targetWidth: 1280,
      targetHeight: 720,
      targetFps: 30
    }
  });
  assert(session.status === 201, `session create returned ${session.status}`);
  const sessionId = session.data.session?.id;
  assert(sessionId, "session id missing");

  const frame = await request(`/sessions/${encodeURIComponent(sessionId)}/frames`, {
    method: "POST",
    body: {
      sequence: 1,
      timestampMs: Date.now(),
      width: 1280,
      height: 720,
      frameDataUrl: "data:image/jpeg;base64,AAAA",
      effects: { face: true, background: true, voice: true }
    }
  });
  assert(frame.status === 200, `frame process returned ${frame.status}`);
  assert(frame.data.frame?.processor === "managed-video-mock", "frame did not use managed video processor");
  console.log("managed video ok");

  const audio = await request(`/sessions/${encodeURIComponent(sessionId)}/audio`, {
    method: "POST",
    body: {
      sequence: 1,
      timestampMs: Date.now(),
      sampleRate: 48000,
      channels: 1,
      format: "pcm_f32le",
      audioDataBase64: "AAAA"
    }
  });
  assert(audio.status === 200, `audio process returned ${audio.status}`);
  assert(audio.data.audio?.processor === "managed-audio-mock", "audio did not use managed audio processor");
  console.log("managed audio ok");

  await request(`/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  console.log("managed processor smoke ok");
} finally {
  sidecar.kill();
}

function commandForProcessor(kind, port) {
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(processorScript)} ${kind} ${port}`;
}

async function request(path, options = {}) {
  const response = await fetch(`${sidecarUrl}${path}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
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

async function waitForManagedProcessors() {
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    try {
      const [video, audio] = await Promise.all([
        fetch(`http://127.0.0.1:${videoPort}/health`),
        fetch(`http://127.0.0.1:${audioPort}/health`)
      ]);
      if (video.ok && audio.ok) return;
    } catch {
      // keep waiting
    }

    await sleep(250);
  }

  fail("managed processors did not become ready");
}

async function getFreePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : null;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
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
