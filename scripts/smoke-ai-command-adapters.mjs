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
const processorScript = fileURLToPath(new URL("../apps/ai-sidecar/processors/shape_processor_command.py", import.meta.url));
const copyScript = fileURLToPath(new URL("./copy-processor-io.mjs", import.meta.url));

const sidecar = spawn(python, ["apps/ai-sidecar/server.py", "--host", "127.0.0.1", "--port", String(sidecarPort)], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    SENTRY_DSN: "",
    SHAPE_AI_MODE: "adapter-contract",
    SHAPE_FACE_ENGINE: "facefusion",
    SHAPE_BACKGROUND_ENGINE: "backgroundmattingv2",
    SHAPE_VOICE_ENGINE: "vcclient000",
    SHAPE_VIDEO_PROCESSOR_COMMAND: processorCommand("video", videoPort),
    SHAPE_VIDEO_PROCESSOR_ENDPOINT: `http://127.0.0.1:${videoPort}/process-frame`,
    SHAPE_VIDEO_PROCESSOR_HEALTH_URL: `http://127.0.0.1:${videoPort}/health`,
    SHAPE_VIDEO_FRAME_COMMAND: copyCommand("video"),
    SHAPE_AUDIO_PROCESSOR_COMMAND: processorCommand("audio", audioPort),
    SHAPE_AUDIO_PROCESSOR_ENDPOINT: `http://127.0.0.1:${audioPort}/process-audio`,
    SHAPE_AUDIO_PROCESSOR_HEALTH_URL: `http://127.0.0.1:${audioPort}/health`,
    SHAPE_AUDIO_CHUNK_COMMAND: copyCommand("audio"),
    SHAPE_PROCESSOR_TIMEOUT_SECS: "3",
    SHAPE_MODEL_COMMAND_TIMEOUT_SECS: "3"
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
  await waitForProcessor(`http://127.0.0.1:${videoPort}/health`, "video");
  await waitForProcessor(`http://127.0.0.1:${audioPort}/health`, "audio");

  const session = await request("/sessions", {
    method: "POST",
    body: {
      meetingCode: "SM-777-888",
      participantId: "host_command",
      identityId: "identity_command",
      identityKind: "PHOTO_IDENTITY",
      identityVersion: "v1",
      identityArtifactUri: "file:///tmp/identity-command.jpg",
      identityCachedArtifactUri: "file:///tmp/identity-command.jpg",
      identityLocalArtifactPath: "/tmp/identity-command.jpg",
      identityArtifactSha256: "abc123",
      identityArtifactSizeBytes: 123,
      faceEnabled: true,
      backgroundEnabled: true,
      backgroundCleanPlateDataUrl: "data:image/jpeg;base64,BBBB",
      backgroundCleanPlateCapturedAt: new Date().toISOString(),
      backgroundCleanPlateWidth: 1280,
      backgroundCleanPlateHeight: 720,
      backgroundCleanPlateCameraDeviceId: "camera_command",
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
      sequence: 42,
      timestampMs: Date.now(),
      width: 1280,
      height: 720,
      frameDataUrl: "data:image/jpeg;base64,AAAA",
      effects: { face: true, background: true, voice: true }
    }
  });
  assert(frame.status === 200, `frame process returned ${frame.status}`);
  assert(frame.data.frame?.processor === "shape-video-command-adapter", "frame did not use command video adapter");
  assert(frame.data.frame?.status === "processed", "frame command adapter did not process output");
  console.log("video command adapter ok");

  const audio = await request(`/sessions/${encodeURIComponent(sessionId)}/audio`, {
    method: "POST",
    body: {
      sequence: 43,
      timestampMs: Date.now(),
      sampleRate: 48000,
      channels: 1,
      format: "pcm_f32le",
      audioDataBase64: "AAAA"
    }
  });
  assert(audio.status === 200, `audio process returned ${audio.status}`);
  assert(audio.data.audio?.processor === "shape-audio-command-adapter", "audio did not use command audio adapter");
  assert(audio.data.audio?.status === "processed", "audio command adapter did not process output");
  console.log("audio command adapter ok");

  await request(`/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  console.log("command adapter smoke ok");
} finally {
  sidecar.kill();
}

function processorCommand(kind, port) {
  return `${JSON.stringify(python)} ${JSON.stringify(processorScript)} --kind ${kind} --host 127.0.0.1 --port ${port}`;
}

function copyCommand(kind) {
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(copyScript)} ${kind}`;
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

  fail(`${label} command processor did not become ready`);
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
