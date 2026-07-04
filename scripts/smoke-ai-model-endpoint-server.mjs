import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const python =
  process.env.SHAPE_AI_SMOKE_PYTHON ?? process.env.SHAPE_AI_PYTHON ?? "python3";
const tempDir = mkdtempSync(join(tmpdir(), "shape-model-endpoint-smoke-"));
const endpointPort = await getFreePort();
const videoPort = await getFreePort();
const audioPort = await getFreePort();
const managedEndpointPort = await getFreePort();
const managedVideoPort = await getFreePort();
const managedAudioPort = await getFreePort();
const envPath = join(tempDir, "shape-ai-runtime.env");
const stageEnvPath = join(tempDir, "shape-ai-runtime-stage.env");
const managedEnvPath = join(tempDir, "shape-ai-runtime-managed.env");
let endpointServer = null;

try {
  endpointServer = spawn(
    process.execPath,
    [
      "scripts/run-model-endpoint-server.mjs",
      "--host",
      "127.0.0.1",
      "--port",
      String(endpointPort),
      "--python",
      python,
      "--demo-effects",
    ],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        SHAPE_MODEL_ENDPOINT_ACCESS_LOG: "false",
      },
    },
  );

  const endpointOutput = captureProcessOutput(endpointServer);
  await waitForEndpoint(endpointOutput);
  await assertEndpointDiagnostics();
  await assertEndpointDemoEffects();
  renderRuntimeEnv();
  assertDefaultCombinedRuntimeEnv();
  assertLocalEndpointRuntimeEnv();

  const report = runPreflight();
  assert(
    report.preflight?.status === "passed",
    "endpoint preflight did not pass",
  );
  assert(
    report.preflight?.checks?.some(
      (check) =>
        check.id === "video" &&
        check.processor === "shape-video-endpoint-adapter",
    ),
    "video preflight did not use default combined endpoint",
  );
  assert(
    report.preflight?.checks?.some(
      (check) =>
        check.id === "audio" &&
        check.processor === "shape-audio-endpoint-adapter",
    ),
    "audio preflight did not use default audio chunk endpoint",
  );
  assert(
    report.preflight?.warnings?.some((warning) =>
      warning.includes("video_frame_endpoint_demo_effect"),
    ),
    "combined video endpoint demo effect warning was not reported",
  );
  assert(
    report.preflight?.warnings?.some((warning) =>
      warning.includes("voice_endpoint_demo_effect"),
    ),
    "voice endpoint demo effect warning was not reported",
  );
  assert(
    report.health?.diagnostics?.engines?.some(
      (engine) => engine.id === "face" && engine.status === "ready",
    ),
    "face engine was not ready with endpoint runtime",
  );

  renderStageRuntimeEnv();
  assertStageRuntimeEnv();
  assertLocalEndpointRuntimeEnv(stageEnvPath);
  const stageReport = runPreflight(stageEnvPath);
  assert(
    stageReport.preflight?.status === "passed",
    "stage endpoint preflight did not pass",
  );
  assert(
    stageReport.preflight?.checks?.some(
      (check) =>
        check.id === "video" &&
        check.processor === "shape-video-model-chain:face+background",
    ),
    "stage video preflight did not use face/background endpoint chain",
  );
  assert(
    stageReport.preflight?.checks?.some(
      (check) =>
        check.id === "audio" &&
        check.processor === "shape-voice-endpoint-adapter",
    ),
    "stage audio preflight did not use voice endpoint adapter",
  );
  assert(
    stageReport.preflight?.warnings?.some((warning) =>
      warning.includes("face_endpoint_demo_effect"),
    ),
    "stage video endpoint demo effect warning was not reported",
  );

  renderManagedRuntimeEnv();
  assertManagedRuntimeEnv();
  assertLocalEndpointRuntimeEnv(managedEnvPath, { allowPassthrough: true });
  const managedReport = runPreflight(managedEnvPath);
  assert(
    managedReport.modelEndpoint?.started === true,
    "preflight did not start the managed model endpoint",
  );
  assert(
    managedReport.modelEndpoint?.url ===
      `http://127.0.0.1:${managedEndpointPort}`,
    "managed model endpoint URL mismatch",
  );
  assert(
    managedReport.health?.diagnostics?.modelEndpoint?.status === "ready",
    "sidecar diagnostics did not report managed model endpoint ready",
  );
  assert(
    managedReport.health?.diagnostics?.modelEndpoint?.url ===
      `http://127.0.0.1:${managedEndpointPort}/diagnostics`,
    "sidecar diagnostics model endpoint URL mismatch",
  );
  assert(
    managedReport.health?.diagnostics?.modelEndpoint?.stageStatus?.[
      "video-frame"
    ] === "ready",
    "sidecar diagnostics did not include video-frame endpoint stage",
  );
  assert(
    managedReport.preflight?.status === "passed",
    "managed endpoint preflight did not pass",
  );
  assert(
    managedReport.preflight?.checks?.some(
      (check) =>
        check.id === "video" &&
        check.processor === "shape-video-endpoint-adapter",
    ),
    "managed video preflight did not use the endpoint adapter",
  );
  assert(
    managedReport.preflight?.checks?.some(
      (check) =>
        check.id === "audio" &&
        check.processor === "shape-audio-endpoint-adapter",
    ),
    "managed audio preflight did not use the endpoint adapter",
  );
  assert(
    managedReport.preflight?.warnings?.some((warning) =>
      warning.includes("video_frame_endpoint_passthrough"),
    ),
    "managed video endpoint passthrough warning was not reported",
  );

  console.log("model endpoint server smoke ok");
} finally {
  if (endpointServer) endpointServer.kill();
  rmSync(tempDir, { recursive: true, force: true });
}

function assertDefaultCombinedRuntimeEnv() {
  const content = readFileSync(envPath, "utf8");
  assert(
    content.includes(
      `SHAPE_VIDEO_FRAME_ENDPOINT=http://127.0.0.1:${endpointPort}/video-frame`,
    ),
    "default local-endpoints runtime did not include /video-frame",
  );
  assert(
    content.includes(
      `SHAPE_AUDIO_CHUNK_ENDPOINT=http://127.0.0.1:${endpointPort}/voice`,
    ),
    "default local-endpoints runtime did not include audio chunk endpoint",
  );
}

function assertStageRuntimeEnv() {
  const content = readFileSync(stageEnvPath, "utf8");
  assert(
    content.includes("# SHAPE_VIDEO_FRAME_ENDPOINT="),
    "stage runtime should disable combined video endpoint",
  );
  assert(
    content.includes("# SHAPE_AUDIO_CHUNK_ENDPOINT="),
    "stage runtime should disable combined audio endpoint",
  );
  assert(
    content.includes(
      `SHAPE_FACE_ENDPOINT=http://127.0.0.1:${endpointPort}/face`,
    ),
    "stage runtime did not include face endpoint",
  );
  assert(
    content.includes(
      `SHAPE_BACKGROUND_ENDPOINT=http://127.0.0.1:${endpointPort}/background`,
    ),
    "stage runtime did not include background endpoint",
  );
}

function assertManagedRuntimeEnv() {
  const content = readFileSync(managedEnvPath, "utf8");
  assert(
    content.includes(
      `SHAPE_MODEL_ENDPOINT_PORT=${managedEndpointPort}`,
    ),
    "managed runtime did not include model endpoint port",
  );
  assert(
    content.includes("SHAPE_WRAPPER_PASSTHROUGH=true"),
    "managed runtime did not enable wrapper passthrough",
  );
}

async function assertEndpointDemoEffects() {
  const face = await postEndpointJson("/face", {
    sequence: 12,
    frame: {
      sequence: 12,
      width: 1280,
      height: 720,
      frameDataUrl: tinyJpegDataUrl(),
    },
    identity: {
      id: "identity_endpoint_demo",
      version: "endpoint-demo",
    },
    enabled: {
      face: true,
      background: true,
      voice: true,
    },
    target: {
      width: 1280,
      height: 720,
      fps: 30,
    },
  });
  assert(
    face.frame?.dataUrl?.startsWith("data:image/svg+xml;base64,"),
    "endpoint demo video did not return an SVG data URL",
  );
  assert(
    face.warnings?.includes("face_endpoint_demo_effect"),
    "endpoint demo video warning missing",
  );

  const combined = await postEndpointJson("/video-frame", {
    sequence: 13,
    frame: {
      sequence: 13,
      width: 1280,
      height: 720,
      frameDataUrl: tinyJpegDataUrl(),
    },
    identity: {
      id: "identity_endpoint_demo",
      version: "endpoint-demo",
    },
    background: {
      cleanPlate: {
        ready: true,
        dataUrl: tinyJpegDataUrl(),
      },
    },
    enabled: {
      face: true,
      background: true,
      voice: true,
    },
    target: {
      width: 1280,
      height: 720,
      fps: 30,
    },
  });
  assert(
    combined.frame?.dataUrl?.startsWith("data:image/svg+xml;base64,"),
    "combined endpoint demo video did not return an SVG data URL",
  );
  assert(
    combined.frame?.format === "image/svg+xml",
    "combined endpoint demo video did not preserve SVG MIME",
  );
  assert(
    combined.warnings?.includes("video_frame_endpoint_demo_effect"),
    "combined endpoint demo video warning missing",
  );

  const voice = await postEndpointJson("/voice", {
    sequence: 7,
    audio: {
      sequence: 7,
      sampleRate: 48000,
      channels: 1,
      format: "pcm_f32le",
      audioDataBase64: Buffer.alloc(480 * 4, 0).toString("base64"),
    },
    identity: {
      id: "identity_endpoint_demo",
    },
  });
  assert(
    voice.audio?.audioDataBase64,
    "endpoint demo voice did not return audio",
  );
  assert(
    voice.warnings?.includes("voice_endpoint_demo_effect"),
    "endpoint demo voice warning missing",
  );
}

async function assertEndpointDiagnostics() {
  const health = await endpointJson("/health");
  assert(
    health.status === "ready",
    "endpoint health should be ready in demo-effects mode",
  );
  assert(
    health.mode === "demo-effects",
    "endpoint health did not report demo-effects mode",
  );
  assert(
    health.stageStatus?.["video-frame"] === "ready",
    "endpoint health did not include ready video-frame stage",
  );

  const data = await endpointJson("/diagnostics");
  const diagnostics = data.diagnostics;
  assert(diagnostics?.ready === true, "endpoint diagnostics was not ready");
  assert(
    diagnostics.mode === "demo-effects",
    "endpoint diagnostics did not report demo-effects mode",
  );
  assert(
    diagnostics.configuration?.demoEffects === true,
    "endpoint diagnostics did not include demoEffects config",
  );
  assert(
    diagnostics.runtime?.wrapperPythonAvailable === "available",
    "endpoint diagnostics wrapper python was not available",
  );
  for (const stage of ["video-frame", "face", "background", "voice"]) {
    assert(
      diagnostics.stageStatus?.[stage] === "ready",
      `endpoint diagnostics stage ${stage} was not ready`,
    );
  }
  assert(
    diagnostics.stages?.some(
      (stage) =>
        stage.id === "face" &&
        stage.ready === true &&
        stage.warnings?.includes("demo-effects activo; no valida modelo real."),
    ),
    "endpoint diagnostics did not explain demo-effects face readiness",
  );
}

async function endpointJson(path) {
  const response = await fetch(`http://127.0.0.1:${endpointPort}${path}`);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  assert(response.ok, `${path} returned HTTP ${response.status}: ${text}`);
  return data;
}

async function postEndpointJson(path, body) {
  const response = await fetch(`http://127.0.0.1:${endpointPort}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  assert(response.ok, `${path} returned HTTP ${response.status}: ${text}`);
  return data;
}

function renderRuntimeEnv() {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/prepare-ai-runtime-models.mjs",
      "--out",
      envPath,
      "--preset",
      "local-endpoints",
      "--video-port",
      String(videoPort),
      "--audio-port",
      String(audioPort),
      "--model-endpoint-host",
      "127.0.0.1",
      "--model-endpoint-port",
      String(endpointPort),
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
    },
  );

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert(
    result.status === 0,
    `runtime generation failed with ${result.status}`,
  );
}

function renderStageRuntimeEnv() {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/prepare-ai-runtime-models.mjs",
      "--out",
      stageEnvPath,
      "--preset",
      "local-endpoints",
      "--video-port",
      String(videoPort),
      "--audio-port",
      String(audioPort),
      "--model-endpoint-host",
      "127.0.0.1",
      "--model-endpoint-port",
      String(endpointPort),
      "--video-frame-endpoint",
      "",
      "--audio-chunk-endpoint",
      "",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
    },
  );

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert(
    result.status === 0,
    `stage runtime generation failed with ${result.status}`,
  );
}

function renderManagedRuntimeEnv() {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/prepare-ai-runtime-models.mjs",
      "--out",
      managedEnvPath,
      "--preset",
      "local-endpoints",
      "--passthrough",
      "--video-port",
      String(managedVideoPort),
      "--audio-port",
      String(managedAudioPort),
      "--model-endpoint-host",
      "127.0.0.1",
      "--model-endpoint-port",
      String(managedEndpointPort),
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
    },
  );

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert(
    result.status === 0,
    `managed runtime generation failed with ${result.status}`,
  );
}

function assertLocalEndpointRuntimeEnv(targetEnvPath = envPath, options = {}) {
  const report = spawnSync(
    process.execPath,
    [
      "scripts/check-ai-model-runtime.mjs",
      "--env-file",
      targetEnvPath,
      "--skip-hardware",
      "--skip-wrapper-smoke",
      "--json",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
    },
  );

  if (report.stderr) process.stderr.write(report.stderr);
  assert(report.status === 0, `models doctor failed with ${report.status}`);
  const parsed = JSON.parse(report.stdout);
  if (options.allowPassthrough) {
    assert(parsed.ok === true, "endpoint runtime doctor was not ok");
    assert(
      parsed.realModelReadiness?.blockers?.length === 0,
      "endpoint runtime had blockers",
    );
    assert(
      parsed.realModelReadiness?.stages?.every(
        (stage) => stage.status === "ready",
      ),
      "endpoint runtime stages were not ready",
    );
    return;
  }

  assert(
    parsed.realModelReadiness?.ready === true,
    "endpoint runtime was not ready",
  );
}

function runPreflight(targetEnvPath = envPath) {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/preflight-ai-runtime-models.mjs",
      "--json",
      "--env-file",
      targetEnvPath,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
    },
  );

  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    throw new Error(`models preflight failed with ${result.status}`);
  }

  return JSON.parse(result.stdout);
}

async function waitForEndpoint(output) {
  const url = `http://127.0.0.1:${endpointPort}/health`;
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    if (endpointServer.exitCode !== null) {
      fail(
        [
          `model endpoint exited early with ${endpointServer.exitCode}`,
          output.stdout.trim(),
          output.stderr.trim(),
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }

    try {
      const response = await fetch(url);
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.status === "ready") return;
    } catch {
      // keep waiting
    }

    await sleep(250);
  }

  fail(
    [
      "model endpoint did not become ready",
      output.stdout.trim(),
      output.stderr.trim(),
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

function captureProcessOutput(child) {
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => {
    output.stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output.stderr += chunk.toString();
  });
  return output;
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

function tinyJpegDataUrl() {
  return (
    "data:image/jpeg;base64," +
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Al//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z"
  );
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function fail(message) {
  throw new Error(message);
}
