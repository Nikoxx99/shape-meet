import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const python =
  process.env.SHAPE_AI_SMOKE_PYTHON ?? process.env.SHAPE_AI_PYTHON ?? "python3";
const sidecarPort = await getFreePort();
const videoPort = await getFreePort();
const audioPort = await getFreePort();
const sidecarUrl = `http://127.0.0.1:${sidecarPort}`;
const processorScript = fileURLToPath(
  new URL(
    "../apps/ai-sidecar/processors/shape_processor_command.py",
    import.meta.url,
  ),
);

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
      SHAPE_FACE_ENGINE: "shape-demo-facefusion",
      SHAPE_BACKGROUND_ENGINE: "shape-demo-backgroundmattingv2",
      SHAPE_VOICE_ENGINE: "shape-demo-vcclient000",
      SHAPE_PROCESSOR_DEMO_EFFECTS: "true",
      SHAPE_VIDEO_PROCESSOR_COMMAND: processorCommand("video", videoPort),
      SHAPE_VIDEO_PROCESSOR_ENDPOINT: `http://127.0.0.1:${videoPort}/process-frame`,
      SHAPE_VIDEO_PROCESSOR_HEALTH_URL: `http://127.0.0.1:${videoPort}/health`,
      SHAPE_VIDEO_FRAME_COMMAND: "",
      SHAPE_AUDIO_PROCESSOR_COMMAND: processorCommand("audio", audioPort),
      SHAPE_AUDIO_PROCESSOR_ENDPOINT: `http://127.0.0.1:${audioPort}/process-audio`,
      SHAPE_AUDIO_PROCESSOR_HEALTH_URL: `http://127.0.0.1:${audioPort}/health`,
      SHAPE_AUDIO_CHUNK_COMMAND: "",
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
  await waitForDemoProcessor(`http://127.0.0.1:${videoPort}/health`, "video");
  await waitForDemoProcessor(`http://127.0.0.1:${audioPort}/health`, "audio");

  const diagnostics = await request("/diagnostics");
  assert(
    diagnostics.status === 200,
    `diagnostics returned ${diagnostics.status}`,
  );
  const processors = diagnostics.data.diagnostics?.managedProcessors ?? [];
  assert(
    processors.some(
      (processor) => processor.id === "video" && processor.status === "running",
    ),
    "video demo processor is not running",
  );
  assert(
    processors.some(
      (processor) => processor.id === "audio" && processor.status === "running",
    ),
    "audio demo processor is not running",
  );

  const session = await request("/sessions", {
    method: "POST",
    body: {
      meetingCode: "SM-909-101",
      participantId: "host_demo_processor",
      identityId: "identity_demo_processor",
      identityKind: "PHOTO_IDENTITY",
      identityVersion: "demo-v1",
      identityArtifactUri: "shape://demo/identity",
      identityCachedArtifactUri: "shape://demo/identity",
      identityLocalArtifactPath: "",
      identityArtifactSha256: "demo",
      identityArtifactSizeBytes: 32,
      faceEnabled: true,
      backgroundEnabled: true,
      backgroundCleanPlateDataUrl: "data:image/png;base64,iVBORw0KGgo=",
      backgroundCleanPlateCapturedAt: new Date().toISOString(),
      backgroundCleanPlateWidth: 640,
      backgroundCleanPlateHeight: 360,
      backgroundCleanPlateCameraDeviceId: "camera_demo_processor",
      voiceEnabled: true,
      targetWidth: 640,
      targetHeight: 360,
      targetFps: 30,
    },
  });
  assert(session.status === 201, `session create returned ${session.status}`);
  const sessionId = session.data.session?.id;
  assert(sessionId, "session id missing");

  const frame = await request(
    `/sessions/${encodeURIComponent(sessionId)}/frames`,
    {
      method: "POST",
      body: {
        sequence: 7,
        timestampMs: Date.now(),
        width: 640,
        height: 360,
        frameDataUrl: "data:image/png;base64,iVBORw0KGgo=",
        effects: { face: true, background: true, voice: true },
      },
    },
  );
  assert(frame.status === 200, `frame process returned ${frame.status}`);
  assert(
    frame.data.frame?.processor === "shape-demo-video-processor",
    "frame did not use demo video processor",
  );
  assert(
    frame.data.frame?.status === "processed",
    "demo video processor did not mark frame processed",
  );
  assert(
    frame.data.frame?.frame?.dataUrl?.startsWith("data:image/svg+xml"),
    "demo video frame did not return SVG data URL",
  );
  const svg = decodeSvgDataUrl(frame.data.frame.frame.dataUrl);
  assert(
    svg.includes("clean plate"),
    "demo video frame did not receive clean plate metadata",
  );
  console.log("demo video processor ok");

  const demoAudioInput = demoAudioBase64();
  const audio = await request(
    `/sessions/${encodeURIComponent(sessionId)}/audio`,
    {
      method: "POST",
      body: {
        sequence: 8,
        timestampMs: Date.now(),
        sampleRate: 48000,
        channels: 1,
        format: "pcm_f32le",
        audioDataBase64: demoAudioInput,
      },
    },
  );
  assert(audio.status === 200, `audio process returned ${audio.status}`);
  assert(
    audio.data.audio?.processor === "shape-demo-audio-processor",
    "audio did not use demo audio processor",
  );
  assert(
    audio.data.audio?.status === "processed",
    "demo audio processor did not mark audio processed",
  );
  assert(
    audio.data.audio?.audio?.audioDataBase64 &&
      audio.data.audio.audio.audioDataBase64 !== demoAudioInput,
    "demo audio processor did not change audio payload",
  );
  assert(
    audio.data.audio?.warnings?.includes("demo_audio_voice_effect"),
    "demo audio processor did not report voice effect warning",
  );
  console.log("demo audio processor ok");

  await request(`/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
  console.log("demo processor smoke ok");
} finally {
  sidecar.kill();
}

function processorCommand(kind, port) {
  return `${JSON.stringify(python)} ${JSON.stringify(processorScript)} --kind ${kind} --host 127.0.0.1 --port ${port}`;
}

function decodeSvgDataUrl(dataUrl) {
  const [, payload = ""] = String(dataUrl).split(",", 2);
  return decodeURIComponent(payload);
}

function demoAudioBase64() {
  const sampleCount = 2048;
  const bytes = Buffer.alloc(sampleCount * 4);

  for (let index = 0; index < sampleCount; index += 1) {
    const envelope = Math.sin((Math.PI * index) / sampleCount);
    const sample =
      Math.sin((2 * Math.PI * 220 * index) / 48000) * envelope * 0.45;
    bytes.writeFloatLE(sample, index * 4);
  }

  return bytes.toString("base64");
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

async function waitForDemoProcessor(url, label) {
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    try {
      const response = await fetch(url);
      const data = await response.json().catch(() => ({}));
      if (
        response.ok &&
        data.status === "ready" &&
        data.mode === "demo-effects"
      )
        return;
    } catch {
      // keep waiting
    }

    await sleep(250);
  }

  fail(`${label} demo processor did not become ready`);
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

function assert(condition, message) {
  if (!condition) fail(message);
}

function fail(message) {
  console.error(message);
  if (stdout.trim()) console.error(`sidecar stdout:\n${stdout.trim()}`);
  if (stderr.trim()) console.error(`sidecar stderr:\n${stderr.trim()}`);
  process.exit(1);
}
