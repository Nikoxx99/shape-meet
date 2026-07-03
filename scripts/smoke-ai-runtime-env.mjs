import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const python =
  process.env.SHAPE_AI_SMOKE_PYTHON ?? process.env.SHAPE_AI_PYTHON ?? "python3";
const tempDir = mkdtempSync(join(tmpdir(), "shape-ai-runtime-"));
const runtimeEnvPath = join(tempDir, "shape-ai-runtime.env");
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
const processorCommand = `${JSON.stringify(python)} ${JSON.stringify(processorScript)}`;

let sidecar = null;
let stdout = "";
let stderr = "";

try {
  renderRuntimeEnv();
  const runtimeEnv = readRuntimeEnv(runtimeEnvPath);

  assert(
    runtimeEnv.SHAPE_PROCESSOR_DEMO_EFFECTS === "true",
    "runtime env did not enable demo effects",
  );
  assert(
    runtimeEnv.SHAPE_VIDEO_PROCESSOR_ENDPOINT?.includes(`:${videoPort}/`),
    "runtime env did not use requested video port",
  );
  assert(
    runtimeEnv.SHAPE_AUDIO_PROCESSOR_ENDPOINT?.includes(`:${audioPort}/`),
    "runtime env did not use requested audio port",
  );

  sidecar = spawn(
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
        ...runtimeEnv,
        SENTRY_DSN: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  sidecar.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  sidecar.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  await waitForSidecar();
  await waitForDemoProcessor(
    runtimeEnv.SHAPE_VIDEO_PROCESSOR_HEALTH_URL,
    "video",
  );
  await waitForDemoProcessor(
    runtimeEnv.SHAPE_AUDIO_PROCESSOR_HEALTH_URL,
    "audio",
  );

  const health = await request("/health");
  assert(
    health.data.mode === "adapter-contract",
    "sidecar did not load runtime env mode",
  );
  assert(
    health.data.diagnostics?.managedProcessors?.some(
      (processor) => processor.id === "video" && processor.status === "running",
    ),
    "video processor is not running from runtime env",
  );
  assert(
    health.data.diagnostics?.managedProcessors?.some(
      (processor) => processor.id === "audio" && processor.status === "running",
    ),
    "audio processor is not running from runtime env",
  );

  const session = await request("/sessions", {
    method: "POST",
    body: {
      meetingCode: "SM-222-333",
      participantId: "host_runtime_env",
      identityId: "identity_runtime_env",
      identityKind: "PHOTO_IDENTITY",
      identityVersion: "runtime-demo-v1",
      identityArtifactUri: "shape://runtime-demo/identity",
      identityCachedArtifactUri: "shape://runtime-demo/identity",
      identityLocalArtifactPath: "",
      identityArtifactSha256: "runtime-demo",
      identityArtifactSizeBytes: 32,
      faceEnabled: true,
      backgroundEnabled: true,
      backgroundCleanPlateDataUrl: "data:image/png;base64,iVBORw0KGgo=",
      backgroundCleanPlateCapturedAt: new Date().toISOString(),
      backgroundCleanPlateWidth: 640,
      backgroundCleanPlateHeight: 360,
      backgroundCleanPlateCameraDeviceId: "camera_runtime_env",
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
        sequence: 11,
        timestampMs: Date.now(),
        width: 640,
        height: 360,
        frameDataUrl: "data:image/png;base64,iVBORw0KGgo=",
        effects: { face: true, background: true, voice: true },
      },
    },
  );
  assert(
    frame.data.frame?.processor === "shape-demo-video-processor",
    "runtime env did not route video to demo processor",
  );

  const audio = await request(
    `/sessions/${encodeURIComponent(sessionId)}/audio`,
    {
      method: "POST",
      body: {
        sequence: 12,
        timestampMs: Date.now(),
        sampleRate: 48000,
        channels: 1,
        format: "pcm_f32le",
        audioDataBase64: "AAAA",
      },
    },
  );
  assert(
    audio.data.audio?.processor === "shape-demo-audio-processor",
    "runtime env did not route audio to demo processor",
  );

  await request(`/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
  console.log("runtime env demo smoke ok");
} finally {
  if (sidecar) {
    sidecar.kill();
  }
  rmSync(tempDir, { recursive: true, force: true });
}

function renderRuntimeEnv() {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/prepare-ai-runtime-demo.mjs",
      "--out",
      runtimeEnvPath,
      "--video-port",
      String(videoPort),
      "--audio-port",
      String(audioPort),
      "--processor-command",
      processorCommand,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
    },
  );

  if (result.status !== 0) {
    fail(
      `demo runtime env generation failed:\n${result.stderr || result.stdout}`,
    );
  }
}

function readRuntimeEnv(path) {
  const env = {};

  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;
    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }

  return env;
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
    if (sidecar?.exitCode !== null) {
      fail(`sidecar exited early with ${sidecar?.exitCode}`);
    }

    try {
      const health = await request("/health");
      if (health.status === 200) return;
    } catch {
      // keep waiting
    }

    await sleep(250);
  }

  fail("sidecar did not become ready from runtime env");
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

  fail(`${label} demo processor from runtime env did not become ready`);
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
