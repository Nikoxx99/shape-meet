import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const python =
  process.env.SHAPE_AI_SMOKE_PYTHON ?? process.env.SHAPE_AI_PYTHON ?? "python3";
const tempDir = mkdtempSync(join(tmpdir(), "shape-ai-model-runtime-"));
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
    runtimeEnv.SHAPE_FACE_COMMAND,
    "model runtime env did not include face command",
  );
  assert(
    runtimeEnv.SHAPE_BACKGROUND_COMMAND,
    "model runtime env did not include background command",
  );
  assert(
    runtimeEnv.SHAPE_VOICE_COMMAND,
    "model runtime env did not include voice command",
  );
  assert(
    runtimeEnv.SHAPE_FACE_COMMAND.includes("facefusion_frame.py"),
    "model runtime env did not use the FaceFusion repo wrapper",
  );
  assert(
    runtimeEnv.SHAPE_BACKGROUND_COMMAND.includes(
      "backgroundmattingv2_frame.py",
    ),
    "model runtime env did not use the BackgroundMattingV2 repo wrapper",
  );
  assert(
    runtimeEnv.SHAPE_VOICE_COMMAND.includes("vcclient000_chunk.py"),
    "model runtime env did not use the vcclient000 repo wrapper",
  );
  assert(
    runtimeEnv.SHAPE_WRAPPER_PASSTHROUGH === "true",
    "model runtime env did not enable wrapper passthrough",
  );
  assert(
    runtimeEnv.SHAPE_MODEL_COMMAND_TIMEOUT_SECS === "3",
    "model runtime env did not preserve model timeout",
  );
  assert(
    runtimeEnv.SHAPE_PROCESSOR_TIMEOUT_SECS === "4",
    "model runtime env did not preserve processor timeout",
  );
  assert(
    runtimeEnv.FACEFUSION_EXECUTION_PROVIDERS === "cuda",
    "model runtime env did not include FaceFusion providers",
  );
  assert(
    runtimeEnv.FACEFUSION_PROCESSORS === "face_swapper face_enhancer",
    "model runtime env did not include FaceFusion processors",
  );
  assert(
    runtimeEnv.BMV2_DEVICE === "cuda",
    "model runtime env did not include BMV2 device",
  );
  assert(
    runtimeEnv.VCCLIENT000_HTTP_MODE === "w-okada-rest",
    "model runtime env did not include vcclient000 HTTP mode",
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
  await waitForProcessor(runtimeEnv.SHAPE_VIDEO_PROCESSOR_HEALTH_URL, "video");
  await waitForProcessor(runtimeEnv.SHAPE_AUDIO_PROCESSOR_HEALTH_URL, "audio");

  const preflight = await request("/preflight", {
    method: "POST",
    body: {
      meetingCode: "SM-MODEL-RUNTIME",
      participantId: "model_runtime",
      identityId: "identity_model_runtime",
      identityKind: "PHOTO_IDENTITY",
      identityVersion: "model-runtime-v1",
      identityArtifactUri: "shape://model-runtime/identity",
      identityCachedArtifactUri: "shape://model-runtime/identity",
      identityLocalArtifactPath: "",
      identityArtifactSha256: "model-runtime",
      identityArtifactSizeBytes: 32,
      faceEnabled: true,
      backgroundEnabled: true,
      backgroundCleanPlateDataUrl: "data:image/png;base64,iVBORw0KGgo=",
      backgroundCleanPlateCapturedAt: new Date().toISOString(),
      backgroundCleanPlateWidth: 640,
      backgroundCleanPlateHeight: 360,
      backgroundCleanPlateCameraDeviceId: "camera_model_runtime",
      voiceEnabled: true,
      targetWidth: 640,
      targetHeight: 360,
      targetFps: 30,
    },
  });

  assert(preflight.status === 200, `preflight returned ${preflight.status}`);
  assert(
    preflight.data.preflight?.status === "passed",
    "model runtime preflight did not pass",
  );
  assert(
    preflight.data.preflight?.checks?.some(
      (check) =>
        check.id === "video" &&
        check.processor === "shape-video-model-chain:face+background",
    ),
    "preflight did not use staged video model commands",
  );
  assert(
    preflight.data.preflight?.checks?.some(
      (check) =>
        check.id === "audio" &&
        check.processor === "shape-voice-command-adapter",
    ),
    "preflight did not use voice model command",
  );

  console.log("model runtime env smoke ok");
} finally {
  if (sidecar) sidecar.kill();
  rmSync(tempDir, { recursive: true, force: true });
}

function renderRuntimeEnv() {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/prepare-ai-runtime-models.mjs",
      "--out",
      runtimeEnvPath,
      "--video-port",
      String(videoPort),
      "--audio-port",
      String(audioPort),
      "--processor-command",
      processorCommand,
      "--preset",
      "local-wrappers",
      "--passthrough",
      "--model-timeout",
      "3",
      "--processor-timeout",
      "4",
      "--facefusion-providers",
      "cuda",
      "--facefusion-processors",
      "face_swapper face_enhancer",
      "--facefusion-extra-args",
      "--execution-thread-count 2",
      "--bmv2-device",
      "cuda",
      "--bmv2-extra-args",
      "--model-refine-sample-pixels 80000",
      "--vcclient000-http-mode",
      "w-okada-rest",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
    },
  );

  if (result.status !== 0) {
    fail(
      `model runtime env generation failed:\n${result.stderr || result.stdout}`,
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

  fail(`${label} processor did not become ready`);
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
