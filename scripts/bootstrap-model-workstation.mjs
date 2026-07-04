import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const args = process.argv.slice(2);
const json = args.includes("--json");
const strict = args.includes("--strict");
const dryRun = args.includes("--dry-run");
const initDirs = args.includes("--init-dirs");
const cloneRepos = args.includes("--clone");
const writeRuntime = args.includes("--write-runtime") && !dryRun;
const writeDemoAssets = args.includes("--write-demo-assets") && !dryRun;
const forceDemoAssets = args.includes("--force-demo-assets");
const writeChecklist = args.includes("--write-checklist");
const writeSetupScript = args.includes("--write-setup-script");
const skipHardware = args.includes("--skip-hardware");
const skipVcclient = args.includes("--skip-vcclient");
const profile = normalizeProfile(
  argValue("--profile") ??
    process.env.SHAPE_MODEL_WORKSTATION_PROFILE ??
    defaultProfile(),
);
const runtimePreset = normalizeRuntimePreset(
  argValue("--runtime-preset") ??
    argValue("--preset") ??
    process.env.SHAPE_MODEL_RUNTIME_PRESET ??
    "local-wrappers",
);
const workspaceRoot = argValue("--workspace") ?? defaultWorkspaceRoot(profile);
const runtimeEnvPath =
  argValue("--out") ??
  process.env.SHAPE_AI_RUNTIME_ENV_FILE ??
  defaultRuntimeEnvPath();
const checklistPath =
  argValue("--checklist-out") ??
  process.env.SHAPE_MODEL_WORKSTATION_CHECKLIST ??
  defaultChecklistPath(profile);
const setupScriptPath =
  argValue("--setup-script-out") ??
  process.env.SHAPE_MODEL_WORKSTATION_SETUP_SCRIPT ??
  defaultSetupScriptPath(profile);
const facefusionRepo =
  argValue("--facefusion-repo") ??
  process.env.FACEFUSION_REPO_URL ??
  "https://github.com/facefusion/facefusion.git";
const bmv2Repo =
  argValue("--bmv2-repo") ??
  process.env.BMV2_REPO_URL ??
  "https://github.com/PeterL1n/BackgroundMattingV2.git";
const vcclientEndpoint =
  argValue("--vcclient000-http-endpoint") ??
  process.env.VCCLIENT000_HTTP_ENDPOINT ??
  defaultVcClientEndpoint(profile);
const vcclientHttpMode =
  argValue("--vcclient000-http-mode") ??
  process.env.VCCLIENT000_HTTP_MODE ??
  "auto";
const modelEndpointHost =
  argValue("--model-endpoint-host") ??
  process.env.SHAPE_MODEL_ENDPOINT_HOST ??
  "127.0.0.1";
const modelEndpointPort =
  argValue("--model-endpoint-port") ??
  process.env.SHAPE_MODEL_ENDPOINT_PORT ??
  "9100";
const modelEndpointBaseUrl = `http://${modelEndpointHost}:${modelEndpointPort}`;
const videoFrameEndpoint =
  argValue("--video-frame-endpoint") ??
  process.env.SHAPE_VIDEO_FRAME_ENDPOINT ??
  (runtimePreset === "local-endpoints"
    ? `${modelEndpointBaseUrl}/video-frame`
    : null);
const faceEndpoint =
  argValue("--face-endpoint") ?? process.env.SHAPE_FACE_ENDPOINT ?? null;
const backgroundEndpoint =
  argValue("--background-endpoint") ??
  process.env.SHAPE_BACKGROUND_ENDPOINT ??
  null;
const audioChunkEndpoint =
  argValue("--audio-chunk-endpoint") ??
  process.env.SHAPE_AUDIO_CHUNK_ENDPOINT ??
  null;
const voiceEndpoint =
  argValue("--voice-endpoint") ?? process.env.SHAPE_VOICE_ENDPOINT ?? null;
const checks = [];
const nextSteps = [];
let runtimeEnv = {};
let runtimeEnvContent = "";
let tempDir = null;
let doctorReport = null;
let checklistWritten = false;
let setupScriptWritten = false;
let demoAssetsWritten = false;

try {
  main();
} finally {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
}

function main() {
  const modelPaths = buildModelPaths(profile, workspaceRoot);

  maybeCreateWorkspace(modelPaths);
  maybeCloneRepo("FaceFusion", facefusionRepo, modelPaths.facefusionDir);
  maybeCloneRepo("BackgroundMattingV2", bmv2Repo, modelPaths.bmv2RepoDir);

  runtimeEnvContent = renderRuntimeEnv(modelPaths);
  runtimeEnv = parseEnv(runtimeEnvContent);

  if (writeDemoAssets) {
    writeDemoAssetFiles(modelPaths);
  } else {
    nextStep(
      `Genera assets técnicos de preflight: pnpm models:bootstrap -- --profile ${profile} --write-demo-assets`,
    );
  }

  if (writeRuntime) {
    runPrepareRuntime(modelPaths, false);
    ok("runtime", `Runtime escrito: ${runtimeEnvPath}`);
  } else {
    warn(
      "runtime",
      dryRun
        ? "Dry-run: runtime no escrito."
        : "Runtime no escrito; usa --write-runtime para aplicarlo.",
    );
    nextStep(
      `Escribe runtime: pnpm models:bootstrap -- --profile ${profile} --write-runtime`,
    );
  }

  checkCommand("git", "Git");
  checkCommand(basePythonCommand(), "Python base");
  if (profile === "windows-nvidia" && !skipHardware) checkNvidia();
  checkFaceFusion(modelPaths);
  checkBackgroundMatting(modelPaths);
  if (!skipVcclient) checkVcClient(vcclientEndpoint, vcclientHttpMode);

  runDoctor(writeTempRuntimeEnv());
  printReport(modelPaths);

  if (strict && (hasErrors() || hasWarnings())) process.exit(1);
}

function maybeCreateWorkspace(modelPaths) {
  const root = fsPath(modelPaths.workspaceRoot);
  if (!root) {
    warn(
      "workspace",
      `Ruta no verificable en ${platform()}: ${modelPaths.workspaceRoot}`,
    );
    return;
  }

  if (existsSync(root)) {
    ok("workspace", `Workspace disponible: ${modelPaths.workspaceRoot}`);
    return;
  }

  if (!initDirs || dryRun) {
    warn("workspace", `Workspace no existe: ${modelPaths.workspaceRoot}`);
    nextStep(
      `Crea workspace: pnpm models:bootstrap -- --profile ${profile} --init-dirs`,
    );
    return;
  }

  mkdirSync(root, { recursive: true });
  ok("workspace", `Workspace creado: ${modelPaths.workspaceRoot}`);
}

function maybeCloneRepo(label, repo, targetPath) {
  if (!cloneRepos || dryRun) return;

  const target = fsPath(targetPath);
  if (!target) {
    warn(label, `No se puede clonar desde ${platform()} hacia ${targetPath}.`);
    return;
  }

  if (existsSync(target)) {
    if (existsSync(join(target, ".git"))) {
      ok(label, `${label} ya existe como repo git: ${targetPath}`);
    } else if (isEmptyDir(target)) {
      cloneRepo(label, repo, target);
    } else {
      warn(label, `${label} ya existe pero no parece repo git: ${targetPath}`);
    }
    return;
  }

  mkdirSync(dirname(target), { recursive: true });
  cloneRepo(label, repo, target);
}

function cloneRepo(label, repo, target) {
  const result = spawnSync("git", ["clone", "--depth", "1", repo, target], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status === 0) {
    ok(label, `${label} clonado: ${target}`);
    return;
  }
  error(
    label,
    `${label} no se pudo clonar desde ${repo}: ${trimProcessOutput(result)}`,
  );
}

function renderRuntimeEnv(modelPaths) {
  const result = runPrepareRuntime(modelPaths, true);
  return result.stdout;
}

function runPrepareRuntime(modelPaths, printOnly) {
  const commandArgs = [
    "scripts/prepare-ai-runtime-models.mjs",
    "--",
    "--profile",
    profile,
    "--preset",
    runtimePreset,
    "--out",
    runtimeEnvPath,
    "--facefusion-dir",
    modelPaths.facefusionDir,
    "--facefusion-python",
    modelPaths.facefusionPython,
    "--bmv2-repo-dir",
    modelPaths.bmv2RepoDir,
    "--bmv2-python",
    modelPaths.bmv2Python,
    "--bmv2-checkpoint",
    modelPaths.bmv2Checkpoint,
  ];

  if (modelPaths.facefusionProviders) {
    commandArgs.push("--facefusion-providers", modelPaths.facefusionProviders);
  }
  if (modelPaths.bmv2Device) {
    commandArgs.push("--bmv2-device", modelPaths.bmv2Device);
  }
  if (vcclientEndpoint) {
    commandArgs.push("--vcclient000-http-endpoint", vcclientEndpoint);
  }
  if (vcclientHttpMode) {
    commandArgs.push("--vcclient000-http-mode", vcclientHttpMode);
  }
  if (runtimePreset === "local-endpoints") {
    commandArgs.push(
      "--model-endpoint-host",
      modelEndpointHost,
      "--model-endpoint-port",
      modelEndpointPort,
    );
  }
  if (videoFrameEndpoint) {
    commandArgs.push("--video-frame-endpoint", videoFrameEndpoint);
  }
  if (faceEndpoint) commandArgs.push("--face-endpoint", faceEndpoint);
  if (backgroundEndpoint) {
    commandArgs.push("--background-endpoint", backgroundEndpoint);
  }
  if (audioChunkEndpoint) {
    commandArgs.push("--audio-chunk-endpoint", audioChunkEndpoint);
  }
  if (voiceEndpoint) commandArgs.push("--voice-endpoint", voiceEndpoint);
  if (printOnly) commandArgs.push("--print");

  const result = spawnSync(process.execPath, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
  });

  if (result.status !== 0) {
    error(
      "runtime",
      `No se pudo generar runtime: ${trimProcessOutput(result)}`,
    );
    if (strict) process.exit(result.status ?? 1);
  }

  return result;
}

function checkFaceFusion(modelPaths) {
  const repoPath = fsPath(modelPaths.facefusionDir);
  const pythonPath = fsPath(modelPaths.facefusionPython);
  if (!repoPath) {
    warn(
      "FaceFusion",
      `Ruta FaceFusion no verificable en ${platform()}: ${modelPaths.facefusionDir}`,
    );
    return;
  }

  if (!existsSync(repoPath)) {
    error(
      "FaceFusion",
      `FACEFUSION_DIR no existe: ${modelPaths.facefusionDir}`,
    );
    nextStep(
      `Clona FaceFusion: git clone ${facefusionRepo} ${modelPaths.facefusionDir}`,
    );
  } else {
    ok("FaceFusion", `FACEFUSION_DIR existe: ${modelPaths.facefusionDir}`);
  }

  const entrypoint = join(repoPath, "facefusion.py");
  if (existsSync(entrypoint)) {
    ok("FaceFusion", "Entrypoint facefusion.py encontrado.");
  } else {
    error(
      "FaceFusion",
      `No se encontró facefusion.py en ${modelPaths.facefusionDir}`,
    );
  }

  if (!pythonPath) {
    warn(
      "FaceFusion",
      `Python FaceFusion no verificable en ${platform()}: ${modelPaths.facefusionPython}`,
    );
  } else if (existsSync(pythonPath)) {
    ok(
      "FaceFusion",
      `Python FaceFusion existe: ${modelPaths.facefusionPython}`,
    );
  } else {
    warn(
      "FaceFusion",
      `Python FaceFusion no existe todavía: ${modelPaths.facefusionPython}`,
    );
    nextStep(
      "Crea el entorno Python de FaceFusion e instala sus dependencias.",
    );
  }
}

function checkBackgroundMatting(modelPaths) {
  const repoPath = fsPath(modelPaths.bmv2RepoDir);
  const pythonPath = fsPath(modelPaths.bmv2Python);
  const checkpointPath = fsPath(modelPaths.bmv2Checkpoint);
  if (!repoPath) {
    warn(
      "BackgroundMattingV2",
      `Ruta BMV2 no verificable en ${platform()}: ${modelPaths.bmv2RepoDir}`,
    );
    return;
  }

  if (!existsSync(repoPath)) {
    error(
      "BackgroundMattingV2",
      `BMV2_REPO_DIR no existe: ${modelPaths.bmv2RepoDir}`,
    );
    nextStep(
      `Clona BackgroundMattingV2: git clone ${bmv2Repo} ${modelPaths.bmv2RepoDir}`,
    );
  } else if (!existsSync(join(repoPath, "inference_images.py"))) {
    error(
      "BackgroundMattingV2",
      `BMV2_REPO_DIR no contiene inference_images.py: ${modelPaths.bmv2RepoDir}`,
    );
  } else {
    ok("BackgroundMattingV2", "Repo BackgroundMattingV2 listo.");
  }

  if (!pythonPath) {
    warn(
      "BackgroundMattingV2",
      `Python BMV2 no verificable en ${platform()}: ${modelPaths.bmv2Python}`,
    );
  } else if (existsSync(pythonPath)) {
    ok("BackgroundMattingV2", `Python BMV2 existe: ${modelPaths.bmv2Python}`);
  } else {
    warn(
      "BackgroundMattingV2",
      `Python BMV2 no existe todavía: ${modelPaths.bmv2Python}`,
    );
    nextStep(
      "Crea el entorno Python de BackgroundMattingV2 e instala sus dependencias.",
    );
  }

  if (!checkpointPath) {
    warn(
      "BackgroundMattingV2",
      `Checkpoint BMV2 no verificable en ${platform()}: ${modelPaths.bmv2Checkpoint}`,
    );
  } else if (existsSync(checkpointPath) && statSync(checkpointPath).size > 0) {
    ok("BackgroundMattingV2", "Checkpoint BackgroundMattingV2 encontrado.");
  } else {
    error(
      "BackgroundMattingV2",
      `Checkpoint BMV2 faltante: ${modelPaths.bmv2Checkpoint}`,
    );
    nextStep(
      "Descarga el checkpoint de BackgroundMattingV2 antes de probar fondo real.",
    );
  }
}

function checkNvidia() {
  const result = spawnSync(
    "nvidia-smi",
    [
      "--query-gpu=name,memory.total,driver_version",
      "--format=csv,noheader,nounits",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (result.status === 0 && result.stdout.trim()) {
    ok("GPU", `NVIDIA detectada: ${result.stdout.trim().split(/\r?\n/)[0]}`);
    return;
  }

  error("GPU", "nvidia-smi no está disponible o no detecta GPU NVIDIA.");
  nextStep(
    "Instala/actualiza driver NVIDIA y confirma `nvidia-smi` antes del demo real.",
  );
}

function checkVcClient(endpoint, mode) {
  if (!endpoint) {
    warn("vcclient000", "Endpoint VCClient no configurado.");
    return;
  }

  let parsed;
  try {
    parsed = new URL(endpoint);
    ok("vcclient000", `Endpoint configurado: ${parsed.href}`);
  } catch {
    error("vcclient000", `Endpoint inválido: ${endpoint}`);
    return;
  }

  const httpMode = normalizeVcClientHttpMode(mode, parsed);
  if (!["w-okada-rest", "shape-json"].includes(httpMode)) {
    error("vcclient000", `VCCLIENT000_HTTP_MODE no soportado: ${mode}`);
    nextStep(
      "Usa VCCLIENT000_HTTP_MODE=w-okada-rest para VCClient oficial o shape-json para un adaptador Shape.",
    );
    return;
  }
  const target = vcClientHealthEndpoint(parsed, httpMode);
  const payload =
    httpMode === "w-okada-rest"
      ? {
          timestamp: Date.now(),
          buffer: Buffer.alloc(480 * 2).toString("base64"),
        }
      : {
          audioDataBase64: Buffer.alloc(480 * 4).toString("base64"),
          sampleRate: 48000,
          channels: 1,
          format: "pcm_f32le",
          identity: "",
        };

  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2500);
      const endpoint = process.argv[1];
      const mode = process.argv[2];
      const payload = JSON.parse(process.argv[3]);
      fetch(endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
        .then(async (response) => {
          clearTimeout(timeout);
          const text = await response.text();
          if (!response.ok) {
            process.stderr.write("HTTP " + response.status + ": " + text.slice(0, 240));
            process.exit(2);
          }
          const data = JSON.parse(text || "{}");
          const ok = mode === "w-okada-rest"
            ? Boolean(data.changedVoiceBase64 || data.data?.changedVoiceBase64)
            : Boolean(data.audioDataBase64 || data.audio?.audioDataBase64);
          if (!ok) {
            process.stderr.write("respuesta sin audio procesado");
            process.exit(3);
          }
          process.stdout.write(String(response.status));
        })
        .catch((error) => {
          clearTimeout(timeout);
          process.stderr.write(error.name || error.message);
          process.exit(2);
        });
      `,
      target,
      httpMode,
      JSON.stringify(payload),
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );

  if (result.status === 0) {
    ok(
      "vcclient000",
      `VCClient ${httpMode} responde POST ${new URL(target).pathname} HTTP ${result.stdout.trim()}.`,
    );
  } else {
    warn(
      "vcclient000",
      `VCClient REST no respondió correctamente: ${trimProcessOutput(result)}`,
    );
    nextStep(
      "Arranca w-okada/VCClient, carga un modelo de voz y confirma POST /test antes del demo real.",
    );
  }
}

function normalizeVcClientHttpMode(mode, parsedEndpoint) {
  const normalized = String(mode || "auto")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (["shape", "shape-json", "shape-meet"].includes(normalized)) {
    return "shape-json";
  }
  if (
    ["w-okada", "w-okada-rest", "vcclient", "vcclient-rest"].includes(
      normalized,
    )
  ) {
    return "w-okada-rest";
  }
  if (normalized !== "auto") return normalized;

  const path = (parsedEndpoint.pathname || "").replace(/\/+$/, "");
  return path === "" || path === "/test" || path.endsWith("/test")
    ? "w-okada-rest"
    : "shape-json";
}

function vcClientHealthEndpoint(parsedEndpoint, mode) {
  const next = new URL(parsedEndpoint.href);
  if (mode === "w-okada-rest" && (!next.pathname || next.pathname === "/")) {
    next.pathname = "/test";
  }
  return next.href;
}

function runDoctor(runtimePath) {
  const commandArgs = [
    "scripts/check-ai-model-runtime.mjs",
    "--",
    "--json",
    "--profile",
    profile,
    "--env-file",
    runtimePath,
  ];
  if (skipHardware) commandArgs.push("--skip-hardware");

  const result = spawnSync(process.execPath, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
  });

  let report = null;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    warn(
      "doctor",
      `models:doctor no devolvió JSON: ${trimProcessOutput(result)}`,
    );
    return;
  }

  doctorReport = report;
  for (const message of report.warnings ?? []) warn("doctor", message);
  for (const message of report.issues ?? []) error("doctor", message);
  for (const message of report.nextSteps ?? []) nextStep(message);
  if (report.ok) ok("doctor", "models:doctor pasó para el runtime generado.");
}

function writeTempRuntimeEnv() {
  if (writeRuntime) return runtimeEnvPath;
  tempDir = mkdtempSync(join(osTmpDir(), "shape-model-bootstrap-"));
  const tempPath = join(tempDir, "shape-ai-runtime.env");
  writeFileSync(tempPath, runtimeEnvContent);
  return tempPath;
}

function buildModelPaths(selectedProfile, root) {
  if (selectedProfile === "apple-silicon") {
    return {
      workspaceRoot: root,
      facefusionDir: joinProfilePath(root, "FaceFusion"),
      facefusionPython: joinProfilePath(root, "FaceFusion/.venv/bin/python"),
      facefusionProviders: "cpu",
      bmv2RepoDir: joinProfilePath(root, "BackgroundMattingV2"),
      bmv2Python: joinProfilePath(root, "BackgroundMattingV2/.venv/bin/python"),
      bmv2Checkpoint: joinProfilePath(
        root,
        "BackgroundMattingV2/pytorch_resnet50.pth",
      ),
      bmv2Device: "mps",
    };
  }

  return {
    workspaceRoot: root,
    facefusionDir: joinProfilePath(root, "FaceFusion"),
    facefusionPython: joinProfilePath(
      root,
      "FaceFusion\\.venv\\Scripts\\python.exe",
    ),
    facefusionProviders: "cuda",
    bmv2RepoDir: joinProfilePath(root, "BackgroundMattingV2"),
    bmv2Python: joinProfilePath(
      root,
      "BackgroundMattingV2\\.venv\\Scripts\\python.exe",
    ),
    bmv2Checkpoint: joinProfilePath(
      root,
      "BackgroundMattingV2\\pytorch_resnet50.pth",
    ),
    bmv2Device: "cuda",
  };
}

function joinProfilePath(root, child) {
  const normalizedRoot = root.replace(/[\\/]+$/, "");
  if (isWindowsPathString(root)) {
    return `${normalizedRoot}\\${child.replace(/\//g, "\\")}`;
  }
  return join(expandHome(normalizedRoot), child);
}

function checkCommand(command, label) {
  const result = spawnSync(
    process.platform === "win32" ? "where" : "which",
    [command],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  if (result.status === 0) ok(label, `${label} disponible: ${command}`);
  else warn(label, `${label} no está en PATH: ${command}`);
}

function basePythonCommand() {
  return process.platform === "win32" ? "python" : "python3";
}

function fsPath(value) {
  if (!value) return null;
  if (isWindowsPathString(value) && process.platform !== "win32") return null;
  return expandHome(value);
}

function expandHome(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function isWindowsPathString(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || value.includes("\\");
}

function isEmptyDir(path) {
  try {
    return readdirSync(path).length === 0;
  } catch {
    return false;
  }
}

function parseEnv(content) {
  const values = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;
    values[line.slice(0, equalsIndex).trim()] = line
      .slice(equalsIndex + 1)
      .trim();
  }
  return values;
}

function buildReport(modelPaths) {
  return {
    ok: !hasErrors() && (!strict || !hasWarnings()),
    profile,
    workspaceRoot,
    runtimePreset,
    runtimeEnvPath,
    runtimeWritten: writeRuntime,
    checklistPath,
    checklistWritten,
    setupScriptPath,
    setupScriptWritten,
    demoAssetsWritten,
    dryRun,
    modelPaths,
    demoAssets: buildDemoAssets(modelPaths),
    realModelReadiness: doctorReport?.realModelReadiness ?? null,
    runtimeEnv: {
      SHAPE_MODEL_WORKSTATION_PROFILE:
        runtimeEnv.SHAPE_MODEL_WORKSTATION_PROFILE,
      SHAPE_MODEL_RUNTIME_PRESET: runtimeEnv.SHAPE_MODEL_RUNTIME_PRESET,
      SHAPE_MODEL_ENDPOINT_HOST: runtimeEnv.SHAPE_MODEL_ENDPOINT_HOST,
      SHAPE_MODEL_ENDPOINT_PORT: runtimeEnv.SHAPE_MODEL_ENDPOINT_PORT,
      SHAPE_VIDEO_FRAME_ENDPOINT: runtimeEnv.SHAPE_VIDEO_FRAME_ENDPOINT,
      SHAPE_FACE_ENDPOINT: runtimeEnv.SHAPE_FACE_ENDPOINT,
      SHAPE_BACKGROUND_ENDPOINT: runtimeEnv.SHAPE_BACKGROUND_ENDPOINT,
      SHAPE_AUDIO_CHUNK_ENDPOINT: runtimeEnv.SHAPE_AUDIO_CHUNK_ENDPOINT,
      SHAPE_VOICE_ENDPOINT: runtimeEnv.SHAPE_VOICE_ENDPOINT,
      FACEFUSION_DIR: runtimeEnv.FACEFUSION_DIR,
      BMV2_REPO_DIR: runtimeEnv.BMV2_REPO_DIR,
      BMV2_MODEL_CHECKPOINT: runtimeEnv.BMV2_MODEL_CHECKPOINT,
      VCCLIENT000_HTTP_ENDPOINT: runtimeEnv.VCCLIENT000_HTTP_ENDPOINT,
      VCCLIENT000_HTTP_MODE: runtimeEnv.VCCLIENT000_HTTP_MODE,
    },
    checks,
    nextSteps,
  };
}

function writeDemoAssetFiles(modelPaths) {
  const assets = buildDemoAssets(modelPaths);
  const files = [
    {
      id: "frame",
      label: "Frame cámara",
      path: assets.frame,
      bytes: tinyJpeg(),
    },
    {
      id: "identity",
      label: "Identidad host técnica",
      path: assets.identity,
      bytes: tinyJpeg(),
    },
    {
      id: "clean-plate",
      label: "Clean plate fondo",
      path: assets.cleanPlate,
      bytes: tinyJpeg(),
    },
    {
      id: "audio",
      label: "Audio voz",
      path: assets.audio,
      bytes: Buffer.alloc(48_000 * 4),
    },
  ];
  let written = 0;

  for (const file of files) {
    const target = fsPath(file.path);
    if (!target) {
      warn(
        `asset-${file.id}`,
        `Ruta de asset no verificable en ${platform()}: ${file.path}`,
      );
      continue;
    }

    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(target) && !forceDemoAssets) {
      const stats = statSync(target);
      if (stats.size > 0) {
        ok(`asset-${file.id}`, `${file.label} ya existe: ${file.path}`);
        written += 1;
        continue;
      }
    }

    writeFileSync(target, file.bytes);
    ok(`asset-${file.id}`, `${file.label} escrito: ${file.path}`);
    written += 1;
  }

  demoAssetsWritten = written === files.length;
  if (demoAssetsWritten) {
    nextStep(
      "Reemplaza identities/host.jpg por la foto/modelo real autorizado antes de una demo comercial.",
    );
  }
}

function buildDemoAssets(modelPaths) {
  return {
    frame: joinProfilePath(modelPaths.workspaceRoot, "samples/frame.jpg"),
    identity: joinProfilePath(modelPaths.workspaceRoot, "identities/host.jpg"),
    cleanPlate: joinProfilePath(
      modelPaths.workspaceRoot,
      "samples/clean-plate.jpg",
    ),
    audio: joinProfilePath(modelPaths.workspaceRoot, "samples/audio.f32le"),
  };
}

function printReport(modelPaths) {
  let report = buildReport(modelPaths);

  if (writeSetupScript) {
    writeSetupScriptFile(report);
    report = buildReport(modelPaths);
  }

  if (writeChecklist) {
    writeChecklistFile(report);
    report = buildReport(modelPaths);
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log("Shape Meet model workstation bootstrap");
  console.log(`Perfil: ${profile}`);
  console.log(`Workspace: ${workspaceRoot}`);
  console.log(`Runtime preset: ${runtimePreset}`);
  console.log(`Runtime env: ${writeRuntime ? runtimeEnvPath : "no escrito"}`);
  if (writeChecklist) {
    console.log(
      `Checklist: ${checklistWritten ? checklistPath : "no escrito"}`,
    );
  }
  if (writeSetupScript) {
    console.log(
      `Setup script: ${setupScriptWritten ? setupScriptPath : "no escrito"}`,
    );
  }
  for (const check of checks) {
    console.log(`${check.status}: ${check.label}: ${check.message}`);
  }
  for (const step of nextSteps) console.log(`next: ${step}`);
}

function writeChecklistFile(report) {
  const target = fsPath(checklistPath);
  if (!target) {
    warn(
      "checklist",
      `Ruta checklist no verificable en ${platform()}: ${checklistPath}`,
    );
    return;
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, renderChecklist(report));
  checklistWritten = true;
  ok("checklist", `Checklist escrito: ${checklistPath}`);
}

function writeSetupScriptFile(report) {
  const target = fsPath(setupScriptPath);
  if (!target) {
    warn(
      "setup-script",
      `Ruta setup script no verificable en ${platform()}: ${setupScriptPath}`,
    );
    return;
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, renderSetupScript(report.modelPaths));
  if (profile === "apple-silicon" && platform() !== "win32") {
    chmodSync(target, 0o755);
  }
  setupScriptWritten = true;
  ok("setup-script", `Setup script escrito: ${setupScriptPath}`);
}

function renderChecklist(report) {
  const statusCounts = {
    ok: report.checks.filter((check) => check.status === "ok").length,
    warn: report.checks.filter((check) => check.status === "warn").length,
    error: report.checks.filter((check) => check.status === "error").length,
  };
  const checkItems = report.checks
    .map((check) => {
      const mark = check.status === "ok" ? "x" : " ";
      return `- [${mark}] ${check.status.toUpperCase()} ${check.label}: ${check.message}`;
    })
    .join("\n");
  const nextStepItems = report.nextSteps.length
    ? report.nextSteps.map((step, index) => `${index + 1}. ${step}`).join("\n")
    : "No quedan siguientes pasos detectados por el bootstrap.";
  const readinessSection = renderReadinessSection(report);

  return `# Shape Meet Model Workstation Checklist

Perfil: ${report.profile}
Workspace: ${report.workspaceRoot}
Runtime preset: ${report.runtimePreset}
Runtime env: ${report.runtimeWritten ? report.runtimeEnvPath : "pendiente"}
Dry-run: ${report.dryRun ? "si" : "no"}

## Estado

- OK: ${statusCounts.ok}
- Advertencias: ${statusCounts.warn}
- Errores: ${statusCounts.error}

## Rutas

- FaceFusion: ${report.modelPaths.facefusionDir}
- Python FaceFusion: ${report.modelPaths.facefusionPython}
- BackgroundMattingV2: ${report.modelPaths.bmv2RepoDir}
- Python BackgroundMattingV2: ${report.modelPaths.bmv2Python}
- Checkpoint BackgroundMattingV2: ${report.modelPaths.bmv2Checkpoint}
- VCClient: ${report.runtimeEnv.VCCLIENT000_HTTP_ENDPOINT || "no configurado"}
- VCClient mode: ${report.runtimeEnv.VCCLIENT000_HTTP_MODE || "auto"}
- Endpoint video combinado: ${report.runtimeEnv.SHAPE_VIDEO_FRAME_ENDPOINT || "no configurado"}
- Endpoint rostro: ${report.runtimeEnv.SHAPE_FACE_ENDPOINT || "no configurado"}
- Endpoint fondo: ${report.runtimeEnv.SHAPE_BACKGROUND_ENDPOINT || "no configurado"}
- Endpoint voz: ${report.runtimeEnv.SHAPE_VOICE_ENDPOINT || "no configurado"}
- Setup script: ${report.setupScriptWritten ? report.setupScriptPath : "pendiente"}
- Assets técnicos escritos: ${report.demoAssetsWritten ? "si" : "no"}

## Checks

${checkItems || "No se ejecutaron checks."}

## Siguientes Pasos

${nextStepItems}

## Readiness demo real

${readinessSection}

## Assets de prueba

- Frame camara: ${report.demoAssets.frame}
- Identidad host: ${report.demoAssets.identity}
- Clean plate fondo: ${report.demoAssets.cleanPlate}
- Audio voz: ${report.demoAssets.audio}

## Comandos

\`\`\`bash
pnpm models:bootstrap -- --profile ${report.profile} --dry-run --write-checklist
pnpm models:bootstrap -- --profile ${report.profile} --write-setup-script
pnpm models:bootstrap -- --profile ${report.profile} --write-demo-assets --write-runtime --strict --write-checklist
pnpm models:bootstrap -- --profile ${report.profile} --runtime-preset local-endpoints --write-runtime --strict --write-checklist
pnpm models:preflight -- --env-file "${report.runtimeEnvPath}" --frame "${report.demoAssets.frame}" --identity "${report.demoAssets.identity}" --clean-plate "${report.demoAssets.cleanPlate}" --audio "${report.demoAssets.audio}" --strict
pnpm demo:real:check -- --env-file "${report.runtimeEnvPath}" --include-desktop --require-real-models --frame "${report.demoAssets.frame}" --identity "${report.demoAssets.identity}" --clean-plate "${report.demoAssets.cleanPlate}" --audio "${report.demoAssets.audio}" --strict
\`\`\`
`;
}

function renderReadinessSection(report) {
  const readiness = report.realModelReadiness;
  if (!readiness) {
    return "models:doctor no entrego readiness estructurado; revisa la seccion de checks.";
  }

  const state = readiness.ready
    ? "listo"
    : readiness.passthroughEnabled
      ? "passthrough"
      : "pendiente";
  const stageItems = readiness.stages
    .map((stage) => {
      const mark =
        stage.status === "ready" || stage.status === "optional" ? "x" : " ";
      const messages = [...(stage.issues ?? []), ...(stage.warnings ?? [])]
        .map((message) => `  - ${message}`)
        .join("\n");
      return [`- [${mark}] ${stage.label}: ${stage.status}`, messages]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");
  const blockers = readiness.blockers?.length
    ? readiness.blockers.map((message) => `- ${message}`).join("\n")
    : "- Sin bloqueantes detectados.";
  const warnings = readiness.warnings?.length
    ? readiness.warnings.map((message) => `- ${message}`).join("\n")
    : "- Sin advertencias detectadas.";

  return `Estado modelos reales: ${state}
Passthrough activo: ${readiness.passthroughEnabled ? "si" : "no"}

### Etapas

${stageItems || "Sin etapas reportadas."}

### Bloqueantes

${blockers}

### Advertencias

${warnings}`;
}

function renderSetupScript(modelPaths) {
  return profile === "windows-nvidia"
    ? renderWindowsSetupScript(modelPaths)
    : renderAppleSetupScript(modelPaths);
}

function renderWindowsSetupScript(modelPaths) {
  const demoAssets = buildDemoAssets(modelPaths);
  return `# Shape Meet Windows/NVIDIA model workstation setup
# Ejecuta desde PowerShell en la estacion RTX. No incluye checkpoints/licencias.
$ErrorActionPreference = "Stop"

$Workspace = ${psQuote(modelPaths.workspaceRoot)}
$FaceFusionDir = ${psQuote(modelPaths.facefusionDir)}
$Bmv2Dir = ${psQuote(modelPaths.bmv2RepoDir)}
$FaceFusionRepo = ${psQuote(facefusionRepo)}
$Bmv2Repo = ${psQuote(bmv2Repo)}
$FaceFusionVenv = Join-Path $FaceFusionDir ".venv"
$Bmv2Venv = Join-Path $Bmv2Dir ".venv"
$FaceFusionPython = Join-Path $FaceFusionVenv "Scripts\\python.exe"
$Bmv2Python = Join-Path $Bmv2Venv "Scripts\\python.exe"
$RuntimeEnvPath = Join-Path $env:LOCALAPPDATA "Shape Meet\\shape-ai-runtime.env"
$FramePath = ${psQuote(demoAssets.frame)}
$IdentityPath = ${psQuote(demoAssets.identity)}
$CleanPlatePath = ${psQuote(demoAssets.cleanPlate)}
$AudioPath = ${psQuote(demoAssets.audio)}

New-Item -ItemType Directory -Force -Path $Workspace | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path $FramePath) | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path $IdentityPath) | Out-Null

if (!(Test-Path $FaceFusionDir)) {
  git clone --depth 1 $FaceFusionRepo $FaceFusionDir
}
if (!(Test-Path $Bmv2Dir)) {
  git clone --depth 1 $Bmv2Repo $Bmv2Dir
}

if (!(Test-Path $FaceFusionPython)) {
  if (Get-Command py -ErrorAction SilentlyContinue) {
    py -3 -m venv $FaceFusionVenv
  } else {
    python -m venv $FaceFusionVenv
  }
}
if (!(Test-Path $Bmv2Python)) {
  if (Get-Command py -ErrorAction SilentlyContinue) {
    py -3 -m venv $Bmv2Venv
  } else {
    python -m venv $Bmv2Venv
  }
}

& $FaceFusionPython -m pip install --upgrade pip
& $Bmv2Python -m pip install --upgrade pip

$FaceFusionRequirements = Join-Path $FaceFusionDir "requirements.txt"
if (Test-Path $FaceFusionRequirements) {
  & $FaceFusionPython -m pip install -r $FaceFusionRequirements
}
$Bmv2Requirements = Join-Path $Bmv2Dir "requirements.txt"
if (Test-Path $Bmv2Requirements) {
  & $Bmv2Python -m pip install -r $Bmv2Requirements
}

Write-Host ""
Write-Host "Manual pendiente:"
Write-Host "- Instala dependencias especificas/licenciadas de FaceFusion si tu version las requiere."
Write-Host "- Descarga el checkpoint BMV2 en: ${modelPaths.bmv2Checkpoint}"
Write-Host "- Arranca w-okada/VCClient y confirma: ${vcclientEndpoint || "endpoint no configurado"}"
Write-Host "- Guarda frame/identidad/clean plate/audio de prueba en:"
Write-Host "  $FramePath"
Write-Host "  $IdentityPath"
Write-Host "  $CleanPlatePath"
Write-Host "  $AudioPath"
Write-Host ""
Write-Host "Validacion:"
Write-Host "pnpm models:bootstrap -- --profile windows-nvidia --write-demo-assets --write-runtime --strict --write-checklist"
Write-Host ('pnpm models:preflight -- --env-file "{0}" --frame "{1}" --identity "{2}" --clean-plate "{3}" --audio "{4}" --strict' -f $RuntimeEnvPath, $FramePath, $IdentityPath, $CleanPlatePath, $AudioPath)
Write-Host ('pnpm demo:real:check -- --env-file "{0}" --include-desktop --require-real-models --frame "{1}" --identity "{2}" --clean-plate "{3}" --audio "{4}" --strict' -f $RuntimeEnvPath, $FramePath, $IdentityPath, $CleanPlatePath, $AudioPath)
`;
}

function renderAppleSetupScript(modelPaths) {
  const demoAssets = buildDemoAssets(modelPaths);
  const workspacePath = expandHome(modelPaths.workspaceRoot);
  return `#!/usr/bin/env bash
# Shape Meet Apple Silicon model workstation setup
# Ejecuta en la Mac objetivo. No incluye checkpoints/licencias.
set -euo pipefail

WORKSPACE=${shQuote(workspacePath)}
FACEFUSION_DIR=${shQuote(modelPaths.facefusionDir)}
BMV2_DIR=${shQuote(modelPaths.bmv2RepoDir)}
FACEFUSION_REPO=${shQuote(facefusionRepo)}
BMV2_REPO=${shQuote(bmv2Repo)}
FACEFUSION_VENV="$FACEFUSION_DIR/.venv"
BMV2_VENV="$BMV2_DIR/.venv"
FACEFUSION_PYTHON="$FACEFUSION_VENV/bin/python"
BMV2_PYTHON="$BMV2_VENV/bin/python"
RUNTIME_ENV_PATH="$HOME/Library/Application Support/Shape Meet/shape-ai-runtime.env"
FRAME_PATH=${shQuote(demoAssets.frame)}
IDENTITY_PATH=${shQuote(demoAssets.identity)}
CLEAN_PLATE_PATH=${shQuote(demoAssets.cleanPlate)}
AUDIO_PATH=${shQuote(demoAssets.audio)}

mkdir -p "$WORKSPACE"
mkdir -p "$(dirname "$FRAME_PATH")" "$(dirname "$IDENTITY_PATH")"

if [ ! -d "$FACEFUSION_DIR/.git" ]; then
  git clone --depth 1 "$FACEFUSION_REPO" "$FACEFUSION_DIR"
fi
if [ ! -d "$BMV2_DIR/.git" ]; then
  git clone --depth 1 "$BMV2_REPO" "$BMV2_DIR"
fi

if [ ! -x "$FACEFUSION_PYTHON" ]; then
  python3 -m venv "$FACEFUSION_VENV"
fi
if [ ! -x "$BMV2_PYTHON" ]; then
  python3 -m venv "$BMV2_VENV"
fi

"$FACEFUSION_PYTHON" -m pip install --upgrade pip
"$BMV2_PYTHON" -m pip install --upgrade pip

if [ -f "$FACEFUSION_DIR/requirements.txt" ]; then
  "$FACEFUSION_PYTHON" -m pip install -r "$FACEFUSION_DIR/requirements.txt"
fi
if [ -f "$BMV2_DIR/requirements.txt" ]; then
  "$BMV2_PYTHON" -m pip install -r "$BMV2_DIR/requirements.txt"
fi

cat <<'NEXT'

Manual pendiente:
- Instala dependencias especificas/licenciadas de FaceFusion si tu version las requiere.
- Descarga el checkpoint BMV2 en: ${modelPaths.bmv2Checkpoint}
- Configura un wrapper/comando de voz compatible en Apple Silicon si no usas VCClient REST.
- Guarda frame/identidad/clean plate/audio de prueba en:
  $FRAME_PATH
  $IDENTITY_PATH
  $CLEAN_PLATE_PATH
  $AUDIO_PATH

Validacion:
pnpm models:bootstrap -- --profile apple-silicon --write-demo-assets --write-runtime --strict --write-checklist
pnpm models:preflight -- --env-file "$RUNTIME_ENV_PATH" --frame "$FRAME_PATH" --identity "$IDENTITY_PATH" --clean-plate "$CLEAN_PLATE_PATH" --audio "$AUDIO_PATH" --strict
pnpm demo:real:check -- --env-file "$RUNTIME_ENV_PATH" --include-desktop --require-real-models --frame "$FRAME_PATH" --identity "$IDENTITY_PATH" --clean-plate "$CLEAN_PLATE_PATH" --audio "$AUDIO_PATH" --strict
NEXT
`;
}

function psQuote(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function shQuote(value) {
  return `'${String(value ?? "").replace(/'/g, "'\\''")}'`;
}

function ok(label, message) {
  checks.push({ status: "ok", label, message });
}

function warn(label, message) {
  checks.push({ status: "warn", label, message });
}

function error(label, message) {
  checks.push({ status: "error", label, message });
}

function nextStep(message) {
  if (!nextSteps.includes(message)) nextSteps.push(message);
}

function hasErrors() {
  return checks.some((check) => check.status === "error");
}

function hasWarnings() {
  return checks.some((check) => check.status === "warn");
}

function normalizeProfile(value) {
  const normalized = String(value || "windows-nvidia")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (["windows", "windows-nvidia", "nvidia", "rtx"].includes(normalized)) {
    return "windows-nvidia";
  }
  if (
    ["apple", "apple-silicon", "mac", "macos", "darwin", "mps"].includes(
      normalized,
    )
  ) {
    return "apple-silicon";
  }
  fail(`Perfil no soportado: ${value}`);
}

function normalizeRuntimePreset(value) {
  const normalized = String(value || "local-wrappers")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (["local-wrappers", "repo-wrappers", "wrappers"].includes(normalized)) {
    return "local-wrappers";
  }
  if (["local-endpoints", "endpoints"].includes(normalized)) {
    return "local-endpoints";
  }
  fail(
    `Preset runtime no soportado: ${value}. Usa local-wrappers o local-endpoints.`,
  );
}

function defaultProfile() {
  return process.platform === "darwin" && process.arch === "arm64"
    ? "apple-silicon"
    : "windows-nvidia";
}

function tinyJpeg() {
  return Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Al//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z",
    "base64",
  );
}

function defaultWorkspaceRoot(selectedProfile) {
  return selectedProfile === "apple-silicon" ? "~/models" : "C:\\models";
}

function defaultVcClientEndpoint(selectedProfile) {
  return selectedProfile === "windows-nvidia"
    ? "http://127.0.0.1:18888/test"
    : "";
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

function defaultChecklistPath(selectedProfile) {
  return join(
    repoRoot,
    "output",
    "model-workstation",
    `shape-model-workstation-${selectedProfile}.md`,
  );
}

function defaultSetupScriptPath(selectedProfile) {
  return join(
    repoRoot,
    "output",
    "model-workstation",
    selectedProfile === "windows-nvidia"
      ? "setup-windows-nvidia.ps1"
      : "setup-apple-silicon.sh",
  );
}

function osTmpDir() {
  return process.env.TMPDIR || process.env.TEMP || "/tmp";
}

function trimProcessOutput(result) {
  return [result.stderr, result.stdout]
    .filter(Boolean)
    .join("\n")
    .trim()
    .slice(0, 1200);
}

function argValue(name) {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
