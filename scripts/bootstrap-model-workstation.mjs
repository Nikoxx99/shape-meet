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
// --engine inproc genera el runtime persistente (motores in-process en :9100,
// saltos colapsados). Sin --engine se conserva el flujo wrappers/legacy intacto.
const engineMode = normalizeEngineMode(
  argValue("--engine") ?? process.env.SHAPE_MODEL_ENDPOINT_ENGINE ?? "",
);
const inproc = engineMode === "inproc";
const runtimePreset = normalizeRuntimePreset(
  argValue("--runtime-preset") ??
    argValue("--preset") ??
    process.env.SHAPE_MODEL_RUNTIME_PRESET ??
    (inproc ? "local-endpoints" : "local-wrappers"),
);
if (inproc && runtimePreset !== "local-endpoints") {
  fail(
    "--engine inproc requiere --runtime-preset local-endpoints (saltos colapsados server.py -> :9100).",
  );
}
// Pesos in-process (modo inproc). El RVM torchscript se descarga del release
// oficial (MIT) con verificación de sha256/tamaño; inswapper_128.onnx es un
// modelo gated de InsightFace y NUNCA se descarga/redistribuye aquí.
const RVM_WEIGHT_FILE = "rvm_mobilenetv3_fp32.torchscript";
const RVM_WEIGHT_URL =
  "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.torchscript";
const RVM_WEIGHT_SHA256 =
  "f01e0c9338b9a6a31b881ea6d4360d70c1e549701b3792e14c9ed88d6196c5a1";
const RVM_WEIGHT_BYTES = 15501891;
const inprocBackgroundEngine = normalizeBackgroundEngine(
  argValue("--background-engine") ??
    process.env.SHAPE_BACKGROUND_ENGINE ??
    "rvm",
);
const weightsDir =
  argValue("--weights-dir") ??
  process.env.SHAPE_MODEL_WEIGHTS_DIR ??
  join(homedir(), ".cache", "shape-meet-airuntime", "weights");
const inswapperModelPath =
  argValue("--inswapper-model") ??
  process.env.SHAPE_INSWAPPER_MODEL ??
  join(weightsDir, "inswapper_128.onnx");
const rvmModelPath =
  argValue("--rvm-model") ??
  process.env.SHAPE_RVM_MODEL ??
  join(weightsDir, RVM_WEIGHT_FILE);
const bmv2InprocCheckpoint =
  argValue("--bmv2-checkpoint") ??
  process.env.BMV2_MODEL_CHECKPOINT ??
  join(weightsDir, "torchscript_resnet50_fp32.pth");
const insightfaceHome =
  argValue("--insightface-home") ??
  process.env.SHAPE_INSIGHTFACE_HOME ??
  process.env.INSIGHTFACE_HOME ??
  join(homedir(), ".insightface");
const faceProviders =
  argValue("--face-providers") ??
  process.env.SHAPE_FACE_EXECUTION_PROVIDERS ??
  (profile === "windows-nvidia" ? "cuda" : "coreml,cpu");
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
// Managed VCClient runtime (engines/vcclient_supervisor.py): the endpoint server
// supervises VCClient itself. Opt-in via --vcclient000-managed / VCCLIENT000_MANAGED.
const vcclientManagedEnabled = /^(1|true|yes|on)$/i.test(
  String(
    argValue("--vcclient000-managed") ?? process.env.VCCLIENT000_MANAGED ?? "",
  ).trim(),
);
const vcclientDistDir =
  argValue("--vcclient000-dist-dir") ??
  process.env.VCCLIENT000_DIST_DIR ??
  defaultVcClientDistDir(profile, workspaceRoot);
const vcclientPort =
  argValue("--vcclient000-port") ?? process.env.VCCLIENT000_PORT ?? "18000";
const vcclientBootTimeout =
  argValue("--vcclient000-boot-timeout") ??
  process.env.VCCLIENT000_BOOT_TIMEOUT_SECS ??
  "90";
// Optional: a URL + sha256 of a packaged VCClient dist archive. When both are
// given the generated setup script downloads/verifies/extracts it; otherwise it
// only validates the dist is present and reports.
const vcclientDistUrl =
  argValue("--vcclient000-dist-url") ??
  process.env.VCCLIENT000_DIST_URL ??
  null;
const vcclientDistSha256 =
  argValue("--vcclient000-dist-sha256") ??
  process.env.VCCLIENT000_DIST_SHA256 ??
  null;
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
  // En inproc los saltos se colapsan a /process-frame|/process-audio y no se
  // usan los endpoints por etapa del preset local-endpoints legacy.
  (runtimePreset === "local-endpoints" && !inproc
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
  if (!inproc) {
    maybeCloneRepo("FaceFusion", facefusionRepo, modelPaths.facefusionDir);
    maybeCloneRepo("BackgroundMattingV2", bmv2Repo, modelPaths.bmv2RepoDir);
  }

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
  if (inproc) {
    checkInprocRuntime(modelPaths);
  } else {
    checkFaceFusion(modelPaths);
    checkBackgroundMatting(modelPaths);
  }
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
  ];

  if (inproc) {
    commandArgs.push(
      "--engine",
      "inproc",
      "--background-engine",
      inprocBackgroundEngine,
      "--inswapper-model",
      modelPaths.inswapperModel,
      "--rvm-model",
      modelPaths.rvmModel,
      "--insightface-home",
      modelPaths.insightfaceHome,
      "--face-providers",
      modelPaths.faceProviders,
      "--endpoint-python",
      modelPaths.inprocPython,
      "--model-endpoint-host",
      modelEndpointHost,
      "--model-endpoint-port",
      modelEndpointPort,
    );
    if (inprocBackgroundEngine === "bmv2") {
      commandArgs.push(
        "--bmv2-checkpoint",
        modelPaths.bmv2TorchscriptCheckpoint,
      );
    }
    if (vcclientEndpoint) {
      commandArgs.push("--vcclient000-http-endpoint", vcclientEndpoint);
    }
    if (vcclientHttpMode) {
      commandArgs.push("--vcclient000-http-mode", vcclientHttpMode);
    }
    if (vcclientManagedEnabled) {
      commandArgs.push(
        "--vcclient000-managed",
        "1",
        "--vcclient000-dist-dir",
        vcclientDistDir,
        "--vcclient000-port",
        String(vcclientPort),
        "--vcclient000-boot-timeout",
        String(vcclientBootTimeout),
      );
    }
    if (printOnly) commandArgs.push("--print");
    return spawnPrepareRuntime(commandArgs);
  }

  commandArgs.push(
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
  );

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
  return spawnPrepareRuntime(commandArgs);
}

function spawnPrepareRuntime(commandArgs) {
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
  // Rutas del runtime persistente (engine inproc). El venv del endpoint vive en
  // el repo (apps/ai-sidecar/.venv-inproc) y los pesos en un cache del host;
  // ambos se referencian por env absolutas en el runtime generado.
  const inprocPaths = {
    engine: inproc ? "inproc" : "wrappers",
    weightsDir,
    inswapperModel: inswapperModelPath,
    rvmModel: rvmModelPath,
    bmv2TorchscriptCheckpoint: bmv2InprocCheckpoint,
    insightfaceHome,
    faceProviders: inproc
      ? faceProviders
      : selectedProfile === "windows-nvidia"
        ? "cuda"
        : "cpu",
    inprocBackgroundEngine,
    inprocVenvDir: join(repoRoot, "apps", "ai-sidecar", ".venv-inproc"),
    inprocPython: join(
      repoRoot,
      "apps",
      "ai-sidecar",
      ".venv-inproc",
      ...(selectedProfile === "windows-nvidia"
        ? ["Scripts", "python.exe"]
        : ["bin", "python"]),
    ),
    inprocRequirements:
      selectedProfile === "windows-nvidia"
        ? "apps/ai-sidecar/requirements-inproc-cuda.txt"
        : "apps/ai-sidecar/requirements-inproc-mac.txt",
    // Managed VCClient runtime (supervised by the endpoint server).
    vcclientManaged: vcclientManagedEnabled,
    vcclientDistDir,
    vcclientPort,
    vcclientBootTimeout,
    vcclientDistUrl,
    vcclientDistSha256,
  };

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
      ...inprocPaths,
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
    ...inprocPaths,
  };
}

function checkInprocRuntime(modelPaths) {
  const requirementsPath = join(repoRoot, modelPaths.inprocRequirements);
  if (existsSync(requirementsPath)) {
    ok("inproc", `Requirements del endpoint: ${modelPaths.inprocRequirements}`);
  } else {
    error("inproc", `Faltan requirements: ${modelPaths.inprocRequirements}`);
  }

  if (existsSync(modelPaths.inprocPython)) {
    ok("inproc", `Venv del endpoint listo: ${modelPaths.inprocPython}`);
  } else {
    warn(
      "inproc",
      `Venv del endpoint no existe todavía: ${modelPaths.inprocPython}`,
    );
    nextStep(
      "Ejecuta el setup script generado (crea el venv del endpoint e instala requirements-inproc).",
    );
  }

  const inswapper = fsPath(modelPaths.inswapperModel);
  if (inswapper && existsSync(inswapper) && statSync(inswapper).size > 0) {
    ok("pesos", `inswapper_128.onnx listo: ${modelPaths.inswapperModel}`);
  } else {
    error(
      "pesos",
      `inswapper_128.onnx faltante: ${modelPaths.inswapperModel} (modelo gated de InsightFace; descarga manual, no redistribuible).`,
    );
    nextStep(
      `Descarga inswapper_128.onnx (gated, licencia InsightFace no comercial) y colócalo en ${modelPaths.inswapperModel}.`,
    );
  }

  if (modelPaths.inprocBackgroundEngine === "bmv2") {
    const checkpoint = fsPath(modelPaths.bmv2TorchscriptCheckpoint);
    if (checkpoint && existsSync(checkpoint) && statSync(checkpoint).size > 0) {
      ok(
        "pesos",
        `BMV2 torchscript listo: ${modelPaths.bmv2TorchscriptCheckpoint}`,
      );
    } else {
      error(
        "pesos",
        `BMV2 torchscript faltante: ${modelPaths.bmv2TorchscriptCheckpoint} (SHAPE_BACKGROUND_ENGINE=bmv2).`,
      );
      nextStep(
        "Descarga el checkpoint torchscript de BackgroundMattingV2 o usa --background-engine rvm.",
      );
    }
  } else {
    const rvm = fsPath(modelPaths.rvmModel);
    if (rvm && existsSync(rvm) && statSync(rvm).size > 0) {
      ok("pesos", `RVM torchscript listo: ${modelPaths.rvmModel}`);
    } else {
      warn(
        "pesos",
        `RVM torchscript faltante: ${modelPaths.rvmModel} (el setup script lo descarga del release oficial con verificación sha256).`,
      );
      nextStep(
        "Ejecuta el setup script generado para descargar rvm_mobilenetv3_fp32.torchscript (MIT).",
      );
    }
  }

  const insightface = fsPath(modelPaths.insightfaceHome);
  if (insightface && existsSync(join(insightface, "models", "buffalo_l"))) {
    ok(
      "pesos",
      `buffalo_l en cache insightface: ${modelPaths.insightfaceHome}`,
    );
  } else {
    warn(
      "pesos",
      `buffalo_l pendiente en ${modelPaths.insightfaceHome}; el setup script hace el warm-up de descarga.`,
    );
  }

  if (modelPaths.vcclientManaged) {
    const distDir = fsPath(modelPaths.vcclientDistDir);
    const binaryName = profile === "windows-nvidia" ? "main.exe" : "main";
    const binaryPath = distDir ? join(distDir, binaryName) : null;
    if (binaryPath && existsSync(binaryPath)) {
      ok(
        "vcclient",
        `VCClient dist gestionado listo: ${binaryPath} (VCCLIENT000_MANAGED=1; el endpoint server lo supervisa).`,
      );
    } else if (modelPaths.vcclientDistUrl) {
      warn(
        "vcclient",
        `VCClient dist pendiente en ${modelPaths.vcclientDistDir}; el setup script lo descarga/verifica (sha256).`,
      );
      nextStep(
        "Ejecuta el setup script generado para descargar/verificar/descomprimir el dist de VCClient.",
      );
    } else {
      warn(
        "vcclient",
        `VCClient dist gestionado no encontrado en ${modelPaths.vcclientDistDir}.`,
      );
      nextStep(
        "Coloca el dist de VCClient v2 (main + model_dir con el slot RVC) en VCCLIENT000_DIST_DIR, o pasa --vcclient000-dist-url + --vcclient000-dist-sha256 para sembrarlo desde el setup script.",
      );
    }
  }
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
    engine: inproc ? "inproc" : "wrappers",
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
      SHAPE_MODEL_ENDPOINT_ENGINE: runtimeEnv.SHAPE_MODEL_ENDPOINT_ENGINE,
      SHAPE_MODEL_ENDPOINT_HOST: runtimeEnv.SHAPE_MODEL_ENDPOINT_HOST,
      SHAPE_MODEL_ENDPOINT_PORT: runtimeEnv.SHAPE_MODEL_ENDPOINT_PORT,
      SHAPE_MODEL_ENDPOINT_PYTHON: runtimeEnv.SHAPE_MODEL_ENDPOINT_PYTHON,
      SHAPE_VIDEO_PROCESSOR_ENDPOINT: runtimeEnv.SHAPE_VIDEO_PROCESSOR_ENDPOINT,
      SHAPE_VIDEO_PROCESSOR_COMMAND: runtimeEnv.SHAPE_VIDEO_PROCESSOR_COMMAND,
      SHAPE_AUDIO_PROCESSOR_ENDPOINT: runtimeEnv.SHAPE_AUDIO_PROCESSOR_ENDPOINT,
      SHAPE_AUDIO_PROCESSOR_COMMAND: runtimeEnv.SHAPE_AUDIO_PROCESSOR_COMMAND,
      SHAPE_VIDEO_FRAME_ENDPOINT: runtimeEnv.SHAPE_VIDEO_FRAME_ENDPOINT,
      SHAPE_FACE_ENDPOINT: runtimeEnv.SHAPE_FACE_ENDPOINT,
      SHAPE_BACKGROUND_ENDPOINT: runtimeEnv.SHAPE_BACKGROUND_ENDPOINT,
      SHAPE_AUDIO_CHUNK_ENDPOINT: runtimeEnv.SHAPE_AUDIO_CHUNK_ENDPOINT,
      SHAPE_VOICE_ENDPOINT: runtimeEnv.SHAPE_VOICE_ENDPOINT,
      SHAPE_BACKGROUND_ENGINE: runtimeEnv.SHAPE_BACKGROUND_ENGINE,
      SHAPE_FACE_EXECUTION_PROVIDERS: runtimeEnv.SHAPE_FACE_EXECUTION_PROVIDERS,
      SHAPE_INSWAPPER_MODEL: runtimeEnv.SHAPE_INSWAPPER_MODEL,
      SHAPE_RVM_MODEL: runtimeEnv.SHAPE_RVM_MODEL,
      INSIGHTFACE_HOME: runtimeEnv.INSIGHTFACE_HOME,
      SHAPE_PROCESSOR_TIMEOUT_SECS: runtimeEnv.SHAPE_PROCESSOR_TIMEOUT_SECS,
      SHAPE_AUDIO_PROCESSOR_TIMEOUT_SECS:
        runtimeEnv.SHAPE_AUDIO_PROCESSOR_TIMEOUT_SECS,
      SHAPE_MODEL_ENDPOINT_TIMEOUT_SECS:
        runtimeEnv.SHAPE_MODEL_ENDPOINT_TIMEOUT_SECS,
      SHAPE_VOICE_ENDPOINT_TIMEOUT_SECS:
        runtimeEnv.SHAPE_VOICE_ENDPOINT_TIMEOUT_SECS,
      SHAPE_MODEL_ENDPOINT_LOAD_TIMEOUT_SECS:
        runtimeEnv.SHAPE_MODEL_ENDPOINT_LOAD_TIMEOUT_SECS,
      FACEFUSION_DIR: runtimeEnv.FACEFUSION_DIR,
      BMV2_REPO_DIR: runtimeEnv.BMV2_REPO_DIR,
      BMV2_MODEL_CHECKPOINT: runtimeEnv.BMV2_MODEL_CHECKPOINT,
      VCCLIENT000_HTTP_ENDPOINT: runtimeEnv.VCCLIENT000_HTTP_ENDPOINT,
      VCCLIENT000_HTTP_MODE: runtimeEnv.VCCLIENT000_HTTP_MODE,
      VCCLIENT000_MANAGED: runtimeEnv.VCCLIENT000_MANAGED,
      VCCLIENT000_DIST_DIR: runtimeEnv.VCCLIENT000_DIST_DIR,
      VCCLIENT000_PORT: runtimeEnv.VCCLIENT000_PORT,
      VCCLIENT000_BOOT_TIMEOUT_SECS: runtimeEnv.VCCLIENT000_BOOT_TIMEOUT_SECS,
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
  console.log(`Engine: ${inproc ? "inproc" : "wrappers"}`);
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

  const routesSection = inproc
    ? [
        `- Engine: inproc (fondo ${report.modelPaths.inprocBackgroundEngine})`,
        `- Venv endpoint: ${report.modelPaths.inprocPython}`,
        `- Requirements endpoint: ${report.modelPaths.inprocRequirements}`,
        `- inswapper_128.onnx (gated, manual): ${report.modelPaths.inswapperModel}`,
        `- RVM torchscript (descarga MIT): ${report.modelPaths.rvmModel}`,
        `- INSIGHTFACE_HOME (buffalo_l): ${report.modelPaths.insightfaceHome}`,
        `- Providers rostro: ${report.modelPaths.faceProviders}`,
        `- Endpoint video (colapsado): ${report.runtimeEnv.SHAPE_VIDEO_PROCESSOR_ENDPOINT || "no configurado"}`,
        `- Endpoint audio (colapsado): ${report.runtimeEnv.SHAPE_AUDIO_PROCESSOR_ENDPOINT || "no configurado"}`,
        `- VCClient (w-okada): ${report.runtimeEnv.VCCLIENT000_HTTP_ENDPOINT || "no configurado"}`,
        `- Setup script: ${report.setupScriptWritten ? report.setupScriptPath : "pendiente"}`,
        `- Assets técnicos escritos: ${report.demoAssetsWritten ? "si" : "no"}`,
      ].join("\n")
    : [
        `- FaceFusion: ${report.modelPaths.facefusionDir}`,
        `- Python FaceFusion: ${report.modelPaths.facefusionPython}`,
        `- BackgroundMattingV2: ${report.modelPaths.bmv2RepoDir}`,
        `- Python BackgroundMattingV2: ${report.modelPaths.bmv2Python}`,
        `- Checkpoint BackgroundMattingV2: ${report.modelPaths.bmv2Checkpoint}`,
        `- VCClient: ${report.runtimeEnv.VCCLIENT000_HTTP_ENDPOINT || "no configurado"}`,
        `- VCClient mode: ${report.runtimeEnv.VCCLIENT000_HTTP_MODE || "auto"}`,
        `- Endpoint video combinado: ${report.runtimeEnv.SHAPE_VIDEO_FRAME_ENDPOINT || "no configurado"}`,
        `- Endpoint rostro: ${report.runtimeEnv.SHAPE_FACE_ENDPOINT || "no configurado"}`,
        `- Endpoint fondo: ${report.runtimeEnv.SHAPE_BACKGROUND_ENDPOINT || "no configurado"}`,
        `- Endpoint voz: ${report.runtimeEnv.SHAPE_VOICE_ENDPOINT || "no configurado"}`,
        `- Setup script: ${report.setupScriptWritten ? report.setupScriptPath : "pendiente"}`,
        `- Assets técnicos escritos: ${report.demoAssetsWritten ? "si" : "no"}`,
      ].join("\n");

  return `# Shape Meet Model Workstation Checklist

Perfil: ${report.profile}
Engine: ${report.engine}
Workspace: ${report.workspaceRoot}
Runtime preset: ${report.runtimePreset}
Runtime env: ${report.runtimeWritten ? report.runtimeEnvPath : "pendiente"}
Dry-run: ${report.dryRun ? "si" : "no"}

## Estado

- OK: ${statusCounts.ok}
- Advertencias: ${statusCounts.warn}
- Errores: ${statusCounts.error}

## Rutas

${routesSection}

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
${modelBootstrapCommand(["--dry-run", "--write-checklist"], report.profile)}
${modelBootstrapCommand(["--write-setup-script"], report.profile)}
${modelBootstrapCommand(["--write-demo-assets", "--write-runtime", "--strict", "--write-checklist"], report.profile)}
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
  if (inproc) {
    return profile === "windows-nvidia"
      ? renderWindowsInprocSetupScript(modelPaths)
      : renderAppleInprocSetupScript(modelPaths);
  }
  return profile === "windows-nvidia"
    ? renderWindowsSetupScript(modelPaths)
    : renderAppleSetupScript(modelPaths);
}

function wokadaProbeBufferBase64() {
  // 480 muestras S16 mono en silencio: payload mínimo válido para POST /test.
  return Buffer.alloc(480 * 2).toString("base64");
}

// El contrato v1 (w-okada legado) solo se asume cuando el endpoint apunta
// explícitamente a /test; cualquier otro caso (incluido el default v2 sin
// path) se prueba como VCClient v2 vía health GET /api/hello (mismo criterio
// de auto-detección "inconclusive" de engines/voice_wokada.py y de
// wrappers/vcclient000_chunk.py::normalize_http_mode).
function vcClientEndpointLooksLikeV1(endpoint) {
  try {
    const path = new URL(endpoint).pathname.replace(/\/+$/, "");
    return path === "/test" || path.endsWith("/test");
  } catch {
    return false;
  }
}

function vcClientHealthUrl(endpoint) {
  try {
    const next = new URL(endpoint);
    next.pathname = "/api/hello";
    next.search = "";
    return next.href;
  } catch {
    return endpoint;
  }
}

function renderAppleVcClientManagedSection(modelPaths) {
  return `echo "== VCClient runtime gestionado (supervisado por el endpoint server) =="
VCCLIENT_DIST_DIR=${shQuote(modelPaths.vcclientDistDir)}
VCCLIENT_BIN="$VCCLIENT_DIST_DIR/main"
VCCLIENT_DIST_URL=${shQuote(modelPaths.vcclientDistUrl || "")}
VCCLIENT_DIST_SHA256=${shQuote(modelPaths.vcclientDistSha256 || "")}
mkdir -p "$VCCLIENT_DIST_DIR"
if [ -n "$VCCLIENT_DIST_URL" ] && [ ! -x "$VCCLIENT_BIN" ]; then
  echo "Descargando dist de VCClient desde $VCCLIENT_DIST_URL"
  TMP_ARCHIVE="$(mktemp -t vcclient-dist)"
  curl -fL --retry 3 -o "$TMP_ARCHIVE" "$VCCLIENT_DIST_URL"
  if [ -n "$VCCLIENT_DIST_SHA256" ]; then
    ACTUAL_SHA=$(shasum -a 256 "$TMP_ARCHIVE" | awk '{print $1}')
    if [ "$ACTUAL_SHA" != "$VCCLIENT_DIST_SHA256" ]; then
      echo "error: sha256 del dist de VCClient no coincide (got $ACTUAL_SHA)." >&2
      rm -f "$TMP_ARCHIVE"; exit 1
    fi
    echo "sha256 del dist verificado."
  else
    echo "warn: sin --vcclient000-dist-sha256; se omite verificación de integridad."
  fi
  case "$VCCLIENT_DIST_URL" in
    *.zip) unzip -o "$TMP_ARCHIVE" -d "$VCCLIENT_DIST_DIR" ;;
    *.tar.gz|*.tgz) tar xzf "$TMP_ARCHIVE" -C "$VCCLIENT_DIST_DIR" ;;
    *.tar) tar xf "$TMP_ARCHIVE" -C "$VCCLIENT_DIST_DIR" ;;
    *) echo "warn: formato de archivo no reconocido; extrae manualmente $TMP_ARCHIVE en $VCCLIENT_DIST_DIR" ;;
  esac
  rm -f "$TMP_ARCHIVE"
fi
if [ -f "$VCCLIENT_BIN" ]; then
  chmod +x "$VCCLIENT_BIN" 2>/dev/null || true
  xattr -dr com.apple.quarantine "$VCCLIENT_DIST_DIR" 2>/dev/null || true
  echo "VCClient dist listo: $VCCLIENT_BIN (VCCLIENT000_MANAGED=1; el endpoint server lo arranca/vigila/apaga)."
else
  echo "PENDIENTE MANUAL: coloca el dist de VCClient v2 (binario main + model_dir con el slot RVC) en:"
  echo "  $VCCLIENT_DIST_DIR"
  echo "  (o pasa --vcclient000-dist-url + --vcclient000-dist-sha256 para descargarlo/verificarlo aquí)."
fi`;
}

function renderAppleInprocSetupScript(modelPaths) {
  const doctorCommand = `pnpm models:doctor -- --profile apple-silicon --env-file "${runtimeEnvPath}"`;
  const resolvedVcClientEndpoint = vcclientEndpoint || "http://127.0.0.1:18000";
  const vcClientProbeSection = modelPaths.vcclientManaged
    ? renderAppleVcClientManagedSection(modelPaths)
    : vcClientEndpointLooksLikeV1(resolvedVcClientEndpoint)
      ? `echo "== Probe VCClient v1 (POST /test) =="
if curl -fsS -m 5 -X POST -H 'content-type: application/json' \\
  -d "{\\"timestamp\\":0,\\"buffer\\":\\"$WOKADA_BUFFER\\"}" \\
  "$WOKADA_ENDPOINT" | grep -q changedVoiceBase64; then
  echo "VCClient v1 (w-okada) responde con changedVoiceBase64 en $WOKADA_ENDPOINT"
else
  echo "warn: VCClient v1 (w-okada) no respondió en $WOKADA_ENDPOINT; arráncalo con un slot RVC cargado antes del demo."
fi`
      : `echo "== Probe VCClient v2 (GET /api/hello) =="
if curl -fsS -m 5 "$WOKADA_HEALTH_ENDPOINT" | grep -qiE 'vcclient|w-okada|cute voice'; then
  echo "VCClient v2 responde en $WOKADA_HEALTH_ENDPOINT"
  echo "nota: la conversion real usa POST $WOKADA_ENDPOINT/api/voice-changer/convert_chunk (multipart waveform Float32 LE; ver engines/voice_wokada.py)."
else
  echo "warn: VCClient v2 no respondió en $WOKADA_HEALTH_ENDPOINT; arráncalo (~40s de boot) con un slot RVC cargado (index_ratio 0.0) antes del demo."
fi`;
  return `#!/usr/bin/env bash
# Shape Meet Apple Silicon in-process AI runtime setup (engine inproc)
# Ejecuta desde la raíz del repo shape-meet. Descarga solo pesos con licencia
# permisiva (RVM, MIT); inswapper_128.onnx es gated y NO se redistribuye.
set -euo pipefail

VENV_DIR=${shQuote(modelPaths.inprocVenvDir)}
VENV_PYTHON=${shQuote(modelPaths.inprocPython)}
REQUIREMENTS=${shQuote(modelPaths.inprocRequirements)}
WEIGHTS_DIR=${shQuote(modelPaths.weightsDir)}
RVM_PATH=${shQuote(modelPaths.rvmModel)}
RVM_URL=${shQuote(RVM_WEIGHT_URL)}
RVM_SHA256=${shQuote(RVM_WEIGHT_SHA256)}
RVM_BYTES=${shQuote(String(RVM_WEIGHT_BYTES))}
INSWAPPER_PATH=${shQuote(modelPaths.inswapperModel)}
INSIGHTFACE_HOME_DIR=${shQuote(modelPaths.insightfaceHome)}
WOKADA_ENDPOINT=${shQuote(resolvedVcClientEndpoint)}
WOKADA_HEALTH_ENDPOINT=${shQuote(vcClientHealthUrl(resolvedVcClientEndpoint))}
WOKADA_BUFFER=${shQuote(wokadaProbeBufferBase64())}

if [ ! -f "$REQUIREMENTS" ]; then
  echo "error: ejecuta este script desde la raíz del repo shape-meet ($REQUIREMENTS no encontrado)." >&2
  exit 1
fi

echo "== Venv del endpoint (inproc) =="
if [ ! -x "$VENV_PYTHON" ]; then
  python3 -m venv "$VENV_DIR"
fi
"$VENV_PYTHON" -m pip install --upgrade pip
"$VENV_PYTHON" -m pip install -r "$REQUIREMENTS"

echo "== Pesos (RVM, MIT — descarga verificada) =="
mkdir -p "$WEIGHTS_DIR" "$INSIGHTFACE_HOME_DIR"
if [ ! -f "$RVM_PATH" ]; then
  curl -fL --retry 3 -o "$RVM_PATH" "$RVM_URL"
fi
ACTUAL_SHA=$(shasum -a 256 "$RVM_PATH" | awk '{print $1}')
ACTUAL_BYTES=$(stat -f%z "$RVM_PATH" 2>/dev/null || stat -c%s "$RVM_PATH")
if [ "$ACTUAL_SHA" != "$RVM_SHA256" ] || [ "$ACTUAL_BYTES" != "$RVM_BYTES" ]; then
  echo "error: RVM torchscript corrupto (sha=$ACTUAL_SHA bytes=$ACTUAL_BYTES); se elimina." >&2
  rm -f "$RVM_PATH"
  exit 1
fi
echo "RVM verificado: $RVM_PATH"

echo "== buffalo_l warm-up (INSIGHTFACE_HOME fijo) =="
INSIGHTFACE_HOME="$INSIGHTFACE_HOME_DIR" "$VENV_PYTHON" - <<PYEOF
import os
from insightface.app import FaceAnalysis
home = os.environ["INSIGHTFACE_HOME"]
analyzer = FaceAnalysis(name="buffalo_l", root=home, providers=["CPUExecutionProvider"])
analyzer.prepare(ctx_id=0, det_size=(640, 640))
print(f"buffalo_l listo en {home}")
PYEOF

echo "== inswapper_128.onnx (gated, manual) =="
if [ -s "$INSWAPPER_PATH" ]; then
  echo "inswapper_128.onnx presente: $INSWAPPER_PATH"
else
  echo "PENDIENTE MANUAL: descarga inswapper_128.onnx (modelo gated de InsightFace,"
  echo "licencia no comercial; este script no lo redistribuye) y colócalo en:"
  echo "  $INSWAPPER_PATH"
fi

${vcClientProbeSection}

echo "== Doctor final =="
${doctorCommand}
`;
}

function renderWindowsVcClientManagedSection(modelPaths) {
  // Windows-specific (untested on this Mac): main.exe, Expand-Archive for zips,
  // no quarantine step; taskkill /T handles teardown in the supervisor.
  return `Write-Host "== VCClient runtime gestionado (supervisado por el endpoint server) =="
$VcClientDistDir = ${psQuote(modelPaths.vcclientDistDir)}
$VcClientBin = Join-Path $VcClientDistDir "main.exe"
$VcClientDistUrl = ${psQuote(modelPaths.vcclientDistUrl || "")}
$VcClientDistSha = ${psQuote(modelPaths.vcclientDistSha256 || "")}
New-Item -ItemType Directory -Force -Path $VcClientDistDir | Out-Null
if ($VcClientDistUrl -and !(Test-Path $VcClientBin)) {
  Write-Host "Descargando dist de VCClient desde $VcClientDistUrl"
  $TmpArchive = Join-Path $env:TEMP "vcclient-dist.zip"
  Invoke-WebRequest -Uri $VcClientDistUrl -OutFile $TmpArchive
  if ($VcClientDistSha) {
    $ActualSha = (Get-FileHash -Algorithm SHA256 $TmpArchive).Hash.ToLowerInvariant()
    if ($ActualSha -ne $VcClientDistSha.ToLowerInvariant()) {
      Remove-Item $TmpArchive -Force
      throw "sha256 del dist de VCClient no coincide (got $ActualSha)."
    }
    Write-Host "sha256 del dist verificado."
  } else {
    Write-Host "warn: sin --vcclient000-dist-sha256; se omite verificacion de integridad."
  }
  Expand-Archive -Path $TmpArchive -DestinationPath $VcClientDistDir -Force
  Remove-Item $TmpArchive -Force
}
if (Test-Path $VcClientBin) {
  Write-Host "VCClient dist listo: $VcClientBin (VCCLIENT000_MANAGED=1; el endpoint server lo arranca/vigila/apaga)."
} else {
  Write-Host "PENDIENTE MANUAL: coloca el dist de VCClient v2 (main.exe + model_dir con el slot RVC) en:"
  Write-Host "  $VcClientDistDir"
  Write-Host "  (o pasa --vcclient000-dist-url + --vcclient000-dist-sha256 para descargarlo/verificarlo aqui)."
}`;
}

function renderWindowsInprocSetupScript(modelPaths) {
  const doctorCommand = `pnpm models:doctor -- --profile windows-nvidia --env-file "${runtimeEnvPath}"`;
  const resolvedVcClientEndpoint = vcclientEndpoint || "http://127.0.0.1:18000";
  const vcClientIsV1 = vcClientEndpointLooksLikeV1(resolvedVcClientEndpoint);
  const vcClientProbeSection = modelPaths.vcclientManaged
    ? renderWindowsVcClientManagedSection(modelPaths)
    : vcClientIsV1
      ? `Write-Host "== Probe VCClient v1 (POST /test) =="
try {
  $Body = '{"timestamp":0,"buffer":"' + $WokadaBuffer + '"}'
  $Response = Invoke-RestMethod -Method Post -Uri $WokadaEndpoint -ContentType 'application/json' -Body $Body -TimeoutSec 5
  if ($Response.changedVoiceBase64 -or $Response.data.changedVoiceBase64) {
    Write-Host "VCClient v1 (w-okada) responde con changedVoiceBase64 en $WokadaEndpoint"
  } else {
    Write-Host "warn: VCClient v1 (w-okada) respondió sin changedVoiceBase64; revisa el slot RVC cargado."
  }
} catch {
  Write-Host "warn: VCClient v1 (w-okada) no respondió en $WokadaEndpoint; arráncalo con un slot RVC cargado antes del demo."
}`
      : `Write-Host "== Probe VCClient v2 (GET /api/hello) =="
try {
  $Hello = Invoke-RestMethod -Method Get -Uri $WokadaHealthEndpoint -TimeoutSec 5
  $HelloText = ($Hello | ConvertTo-Json -Compress).ToLowerInvariant()
  if ($HelloText -match 'vcclient|w-okada|cute voice') {
    Write-Host "VCClient v2 responde en $WokadaHealthEndpoint"
    Write-Host "nota: la conversion real usa POST $WokadaEndpoint/api/voice-changer/convert_chunk (multipart waveform Float32 LE; ver engines/voice_wokada.py)."
  } else {
    Write-Host "warn: $WokadaHealthEndpoint respondió pero no parece VCClient; revisa el slot RVC cargado."
  }
} catch {
  Write-Host "warn: VCClient v2 no respondió en $WokadaHealthEndpoint; arráncalo (~40s de boot) con un slot RVC cargado (index_ratio 0.0) antes del demo."
}`;
  return `# Shape Meet Windows/NVIDIA in-process AI runtime setup (engine inproc)
# Ejecuta desde PowerShell en la raíz del repo shape-meet de la estación RTX.
# Descarga solo pesos con licencia permisiva (RVM, MIT); inswapper_128.onnx es
# gated y NO se redistribuye.
$ErrorActionPreference = "Stop"

$VenvDir = ${psQuote(modelPaths.inprocVenvDir)}
$VenvPython = ${psQuote(modelPaths.inprocPython)}
$Requirements = ${psQuote(modelPaths.inprocRequirements.replace(/\//g, "\\"))}
$WeightsDir = ${psQuote(modelPaths.weightsDir)}
$RvmPath = ${psQuote(modelPaths.rvmModel)}
$RvmUrl = ${psQuote(RVM_WEIGHT_URL)}
$RvmSha256 = ${psQuote(RVM_WEIGHT_SHA256)}
$RvmBytes = ${RVM_WEIGHT_BYTES}
$InswapperPath = ${psQuote(modelPaths.inswapperModel)}
$InsightfaceHome = ${psQuote(modelPaths.insightfaceHome)}
$WokadaEndpoint = ${psQuote(resolvedVcClientEndpoint)}
$WokadaHealthEndpoint = ${psQuote(vcClientHealthUrl(resolvedVcClientEndpoint))}
$WokadaBuffer = ${psQuote(wokadaProbeBufferBase64())}

if (!(Test-Path $Requirements)) {
  throw "Ejecuta este script desde la raíz del repo shape-meet ($Requirements no encontrado)."
}

Write-Host "== Venv del endpoint (inproc) =="
if (!(Test-Path $VenvPython)) {
  if (Get-Command py -ErrorAction SilentlyContinue) {
    py -3 -m venv $VenvDir
  } else {
    python -m venv $VenvDir
  }
}
& $VenvPython -m pip install --upgrade pip
& $VenvPython -m pip install -r $Requirements

Write-Host "== Pesos (RVM, MIT - descarga verificada) =="
New-Item -ItemType Directory -Force -Path $WeightsDir | Out-Null
New-Item -ItemType Directory -Force -Path $InsightfaceHome | Out-Null
if (!(Test-Path $RvmPath)) {
  Invoke-WebRequest -Uri $RvmUrl -OutFile $RvmPath
}
$ActualSha = (Get-FileHash -Algorithm SHA256 $RvmPath).Hash.ToLowerInvariant()
$ActualBytes = (Get-Item $RvmPath).Length
if ($ActualSha -ne $RvmSha256 -or $ActualBytes -ne $RvmBytes) {
  Remove-Item $RvmPath -Force
  throw "RVM torchscript corrupto (sha=$ActualSha bytes=$ActualBytes); descarga de nuevo."
}
Write-Host "RVM verificado: $RvmPath"

Write-Host "== buffalo_l warm-up (INSIGHTFACE_HOME fijo) =="
$env:INSIGHTFACE_HOME = $InsightfaceHome
$WarmupCode = "from insightface.app import FaceAnalysis; FaceAnalysis(name='buffalo_l', root=r'$InsightfaceHome', providers=['CPUExecutionProvider']).prepare(ctx_id=0, det_size=(640, 640)); print('buffalo_l listo')"
& $VenvPython -c $WarmupCode

Write-Host "== inswapper_128.onnx (gated, manual) =="
if ((Test-Path $InswapperPath) -and ((Get-Item $InswapperPath).Length -gt 0)) {
  Write-Host "inswapper_128.onnx presente: $InswapperPath"
} else {
  Write-Host "PENDIENTE MANUAL: descarga inswapper_128.onnx (modelo gated de InsightFace,"
  Write-Host "licencia no comercial; este script no lo redistribuye) y colócalo en:"
  Write-Host "  $InswapperPath"
}

${vcClientProbeSection}

Write-Host "== Doctor final =="
${doctorCommand}
`;
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
Write-Host ${psQuote(modelBootstrapCommand(["--write-demo-assets", "--write-runtime", "--strict", "--write-checklist"], "windows-nvidia"))}
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
${modelBootstrapCommand(["--write-demo-assets", "--write-runtime", "--strict", "--write-checklist"], "apple-silicon")}
pnpm models:preflight -- --env-file "$RUNTIME_ENV_PATH" --frame "$FRAME_PATH" --identity "$IDENTITY_PATH" --clean-plate "$CLEAN_PLATE_PATH" --audio "$AUDIO_PATH" --strict
pnpm demo:real:check -- --env-file "$RUNTIME_ENV_PATH" --include-desktop --require-real-models --frame "$FRAME_PATH" --identity "$IDENTITY_PATH" --clean-plate "$CLEAN_PLATE_PATH" --audio "$AUDIO_PATH" --strict
NEXT
`;
}

function modelBootstrapCommand(extraArgs = [], selectedProfile = profile) {
  return commandLine([
    "pnpm",
    "models:bootstrap",
    "--",
    ...modelBootstrapRuntimeArgs(selectedProfile),
    ...extraArgs,
  ]);
}

function modelBootstrapRuntimeArgs(selectedProfile) {
  const values = [
    "--profile",
    selectedProfile,
    "--runtime-preset",
    runtimePreset,
  ];

  if (inproc) {
    values.push("--engine", "inproc");
    values.push(
      "--model-endpoint-host",
      modelEndpointHost,
      "--model-endpoint-port",
      modelEndpointPort,
    );
    return values;
  }

  if (runtimePreset === "local-endpoints") {
    values.push(
      "--model-endpoint-host",
      modelEndpointHost,
      "--model-endpoint-port",
      modelEndpointPort,
    );
    pushOptional(values, "--video-frame-endpoint", videoFrameEndpoint);
    pushOptional(values, "--face-endpoint", faceEndpoint);
    pushOptional(values, "--background-endpoint", backgroundEndpoint);
    pushOptional(values, "--audio-chunk-endpoint", audioChunkEndpoint);
    pushOptional(values, "--voice-endpoint", voiceEndpoint);
  }

  return values;
}

function commandLine(parts) {
  return parts.map(commandArg).join(" ");
}

function commandArg(value) {
  const text = String(value ?? "");
  if (/^[A-Za-z0-9_./:@-]+$/.test(text)) return text;
  return JSON.stringify(text);
}

function pushOptional(target, name, value) {
  if (value) target.push(name, value);
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

function defaultVcClientDistDir(selectedProfile, root) {
  // Managed runtime: the VCClient dist (binary + model_dir) lives under the
  // workstation workspace so the setup script can seed it and the runtime env
  // can point VCCLIENT000_DIST_DIR at it.
  return joinProfilePath(root, "vcclient/dist");
}

function defaultVcClientEndpoint(selectedProfile) {
  // El engine inproc siempre necesita VCClient configurado; el cliente
  // persistente (engines/voice_wokada.py) resuelve v1/v2 con
  // VCCLIENT000_HTTP_MODE=auto (GET /api/hello), así que el default apunta al
  // puerto de VCClient v2 (18000) sin path fijo. En wrappers (subproceso por
  // chunk) solo la workstation Windows asume por defecto el REST v1 legado de
  // w-okada (18888/test); ver workstationProfileDefaults en
  // prepare-ai-runtime-models.mjs.
  if (inproc) return "http://127.0.0.1:18000";
  return selectedProfile === "windows-nvidia"
    ? "http://127.0.0.1:18888/test"
    : "";
}

function normalizeEngineMode(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (!normalized || normalized === "wrappers") return "";
  if (["inproc", "in-proc", "in-process", "inprocess"].includes(normalized)) {
    return "inproc";
  }
  fail(`Engine no soportado: ${value}. Usa inproc o wrappers.`);
}

function normalizeBackgroundEngine(value) {
  // Mismos alias que engines/background_matting.create_background_engine().
  const normalized = String(value || "rvm")
    .trim()
    .toLowerCase();
  return ["bmv2", "backgroundmattingv2", "bgmv2"].includes(normalized)
    ? "bmv2"
    : "rvm";
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
