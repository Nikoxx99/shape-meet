import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { once } from "node:events";

const args = process.argv.slice(2);
const json = args.includes("--json");
const strict = args.includes("--strict");
const keepSidecar = args.includes("--keep-sidecar");
const skipVideo = args.includes("--skip-video");
const skipAudio = args.includes("--skip-audio");
const runtimeEnvPath =
  argValue("--env-file") ??
  process.env.SHAPE_AI_RUNTIME_ENV_FILE ??
  defaultRuntimeEnvPath();
const sidecarPython =
  argValue("--python") ??
  process.env.SHAPE_AI_SMOKE_PYTHON ??
  process.env.SHAPE_AI_PYTHON ??
  (process.platform === "win32" ? "python" : "python3");
const sidecarHost = argValue("--host") ?? "127.0.0.1";
const sidecarPort = Number(argValue("--port") ?? 0) || (await getFreePort());
const sidecarUrl = `http://${sidecarHost}:${sidecarPort}`;
const timeoutMs = positiveInteger(argValue("--timeout-ms"), 45_000);
const tempDir = mkdtempSync(join(tmpdir(), "shape-model-preflight-"));
let sidecar = null;

try {
  const report = await main();
  printReport(report);

  if (
    report.preflight.status === "failed" ||
    (strict &&
      (report.preflight.status !== "passed" ||
        report.preflight.warnings.length > 0))
  ) {
    process.exit(1);
  }
} finally {
  if (!keepSidecar) await stopSidecar();
  rmSync(tempDir, { recursive: true, force: true });
}

async function main() {
  if (!existsSync(runtimeEnvPath)) {
    throw new Error(
      [
        `No existe runtime env de modelos: ${runtimeEnvPath}`,
        "Generalo con `pnpm models:runtime -- --preset local-wrappers --passthrough` o `pnpm models:bootstrap -- --write-runtime`.",
      ].join("\n"),
    );
  }

  const runtimeEnv = readEnvFile(runtimeEnvPath);
  const assets = prepareAssets();
  sidecar = spawn(
    sidecarPython,
    [
      "apps/ai-sidecar/server.py",
      "--host",
      sidecarHost,
      "--port",
      String(sidecarPort),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...runtimeEnv,
        SENTRY_DSN: "",
        SHAPE_AI_ACCESS_LOG: "false",
        SHAPE_AI_PORT: String(sidecarPort),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const output = captureProcessOutput(sidecar);
  await waitForSidecar(output, runtimeEnv);

  const health = await requestJson("/health");
  const preflight = await requestJson("/preflight", {
    method: "POST",
    body: preflightPayload(assets),
  });

  return {
    ok: preflight.preflight?.status === "passed",
    runtimeEnvPath,
    sidecarUrl,
    sidecarPid: sidecar.pid,
    health,
    preflight: preflight.preflight,
    stdout: output.stdout.trim().split(/\r?\n/).filter(Boolean).slice(-8),
    stderr: output.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-8),
  };
}

function prepareAssets() {
  const framePath = resolveAssetPath("--frame", "frame.jpg", tinyJpeg());
  const identityPath = resolveAssetPath(
    "--identity",
    "identity.jpg",
    tinyJpeg(),
  );
  const cleanPlatePath = resolveAssetPath(
    "--clean-plate",
    "clean-plate.jpg",
    tinyJpeg(),
  );
  const audioPath = resolveAssetPath(
    "--audio",
    "audio.f32le",
    Buffer.alloc(480 * 4),
  );

  return {
    framePath,
    frameDataUrl: fileToDataUrl(framePath, mimeTypeForPath(framePath)),
    identityPath,
    cleanPlatePath,
    cleanPlateDataUrl: fileToDataUrl(
      cleanPlatePath,
      mimeTypeForPath(cleanPlatePath),
    ),
    audioPath,
    audioDataBase64: readFileSync(audioPath).toString("base64"),
  };
}

function resolveAssetPath(argName, fallbackName, fallbackBytes) {
  const explicit = argValue(argName);
  if (explicit) {
    const path = resolve(explicit);
    if (!existsSync(path)) {
      throw new Error(`${argName} no existe: ${path}`);
    }
    return path;
  }

  const path = join(tempDir, fallbackName);
  writeFileSync(path, fallbackBytes);
  return path;
}

function preflightPayload(assets) {
  return {
    meetingCode: "SM-PRE-FLIGHT",
    participantId: "model-preflight",
    identityId: "identity-preflight",
    identityKind: "PHOTO_IDENTITY",
    identityVersion: `preflight-${basename(assets.identityPath)}`,
    identityArtifactUri: `file://${assets.identityPath}`,
    identityCachedArtifactUri: `file://${assets.identityPath}`,
    identityLocalArtifactPath: assets.identityPath,
    identityArtifactSha256: null,
    identityArtifactSizeBytes: readFileSync(assets.identityPath).byteLength,
    faceEnabled: !skipVideo,
    backgroundEnabled: !skipVideo,
    backgroundCleanPlateDataUrl: skipVideo ? null : assets.cleanPlateDataUrl,
    backgroundCleanPlateCapturedAt: new Date().toISOString(),
    backgroundCleanPlateWidth: 1280,
    backgroundCleanPlateHeight: 720,
    backgroundCleanPlateCameraDeviceId: "model-preflight-camera",
    voiceEnabled: !skipAudio,
    targetWidth: 1280,
    targetHeight: 720,
    targetFps: 30,
    frameDataUrl: skipVideo ? null : assets.frameDataUrl,
    audioDataBase64: skipAudio ? null : assets.audioDataBase64,
    audioSampleRate: 48000,
  };
}

async function waitForSidecar(output, runtimeEnv) {
  const needsVideoProcessor =
    !skipVideo && processorConfigured("video", runtimeEnv);
  const needsAudioProcessor =
    !skipAudio && processorConfigured("audio", runtimeEnv);
  const deadline = Date.now() + timeoutMs;
  let last = null;

  while (Date.now() < deadline) {
    if (sidecar.exitCode !== null) {
      throw new Error(
        [
          `Sidecar terminó antes del preflight con código ${sidecar.exitCode}.`,
          output.stdout.trim(),
          output.stderr.trim(),
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }

    const diagnostics = await requestJson("/diagnostics").catch(() => null);
    last = diagnostics;
    if (
      diagnostics?.diagnostics &&
      processorReady(diagnostics.diagnostics, "video", needsVideoProcessor) &&
      processorReady(diagnostics.diagnostics, "audio", needsAudioProcessor)
    ) {
      return;
    }

    await sleep(500);
  }

  throw new Error(
    [
      `Sidecar no quedó listo dentro de ${timeoutMs}ms.`,
      last ? JSON.stringify(last, null, 2) : "",
      output.stdout.trim(),
      output.stderr.trim(),
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

function processorConfigured(kind, runtimeEnv) {
  const prefix = kind === "video" ? "SHAPE_VIDEO" : "SHAPE_AUDIO";
  return Boolean(
    runtimeEnv[`${prefix}_PROCESSOR_COMMAND`] ||
    runtimeEnv[`${prefix}_PROCESSOR_ENDPOINT`],
  );
}

function processorReady(diagnostics, kind, required) {
  if (!required) return true;
  const processor = diagnostics.managedProcessors?.find(
    (candidate) => candidate.id === kind,
  );
  if (!processor) return false;
  if (processor.status !== "running") return false;
  const health = processor.health ?? {};
  return health.status === "ready" || health.status === "not-configured";
}

async function requestJson(path, options = {}) {
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
    data = { raw: text.slice(0, 800) };
  }

  if (!response.ok) {
    throw new Error(
      `${path} devolvió HTTP ${response.status}: ${text.slice(0, 800)}`,
    );
  }

  return data;
}

function captureProcessOutput(child) {
  const output = { stdout: "", stderr: "" };
  child.stdout?.on("data", (chunk) => {
    output.stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    output.stderr += String(chunk);
  });
  return output;
}

async function stopSidecar() {
  if (!sidecar || sidecar.exitCode !== null || sidecar.signalCode) return;

  await new Promise((resolve) => {
    const forceTimer = setTimeout(() => {
      if (sidecar.exitCode === null) sidecar.kill("SIGTERM");
    }, 2500);
    sidecar.once("exit", () => {
      clearTimeout(forceTimer);
      resolve();
    });
    sidecar.kill("SIGINT");
  });
}

function printReport(report) {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log("Shape Meet model runtime preflight");
  console.log(`Runtime env: ${report.runtimeEnvPath}`);
  console.log(`Sidecar: ${report.sidecarUrl}`);
  console.log(`Estado: ${report.preflight.status}`);
  for (const check of report.preflight.checks) {
    const latency = check.latencyMs ? `${check.latencyMs}ms` : "sin latencia";
    console.log(
      `- ${check.label}: ${check.status} · ${check.processor ?? "sin procesador"} · ${latency}`,
    );
  }
  for (const warning of report.preflight.warnings ?? []) {
    console.log(`warning: ${warning}`);
  }
}

function readEnvFile(path) {
  const values = {};

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
    values[key] = value;
  }

  return values;
}

function fileToDataUrl(path, mimeType) {
  return `data:${mimeType};base64,${readFileSync(path).toString("base64")}`;
}

function mimeTypeForPath(path) {
  const normalized = path.toLowerCase();
  if (normalized.endsWith(".png")) return "image/png";
  if (normalized.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
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
  if (!port) throw new Error("No se pudo reservar un puerto libre.");
  return port;
}

function defaultRuntimeEnvPath() {
  if (process.platform === "win32") {
    return join(
      process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
      "Shape Meet",
      "shape-ai-runtime.env",
    );
  }
  if (process.platform === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "Shape Meet",
      "shape-ai-runtime.env",
    );
  }
  return join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "shape-meet",
    "shape-ai-runtime.env",
  );
}

function tinyJpeg() {
  return Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Al//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z",
    "base64",
  );
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function argValue(name) {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}
