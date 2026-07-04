import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const args = process.argv.slice(2);
const strict = args.includes("--strict");
const json = args.includes("--json");
const skipHardware = args.includes("--skip-hardware");
const skipWrapperSmoke = args.includes("--skip-wrapper-smoke");
const endpointLive = args.includes("--endpoint-live");
const envFile =
  argValue("--env-file") ??
  process.env.SHAPE_AI_RUNTIME_ENV_FILE ??
  defaultRuntimeEnvPath();
const env = {
  ...readEnvFile(".env.local"),
  ...readEnvFile("apps/desktop/.env.local"),
  ...readEnvFile("apps/admin/.env.local"),
  ...readEnvFile(envFile),
  ...process.env,
};
const workstationProfile = normalizeWorkstationProfile(
  argValue("--profile") ??
    env.SHAPE_MODEL_WORKSTATION_PROFILE ??
    defaultWorkstationProfile(),
);
// Mirrors engines/__init__.py engine_mode(): explicit SHAPE_MODEL_ENDPOINT_ENGINE
// wins; otherwise the legacy passthrough/demo flags; otherwise wrappers.
const engineMode = resolveEngineMode();
const inprocMode = engineMode === "inproc";
const checks = [];
const warnings = [];
const issues = [];
const nextSteps = [];
let nvidiaAvailable = false;
let inprocProbe = null;
let endpointLiveReport = null;
const hardware = {
  checked: !skipHardware,
  profile: workstationProfile,
  platform: platform(),
  arch: process.arch,
  gpuRuntime: "unknown",
  status: skipHardware ? "skipped" : "unknown",
  readyForLocalModels: false,
  message: skipHardware
    ? "Hardware omitido por --skip-hardware."
    : "Hardware pendiente de validar.",
  gpus: [],
  warnings: [],
  issues: [],
};

await main();

async function main() {
  checkBaseFiles();
  checkRuntimeEnv();
  if (!skipHardware) checkHardware();
  checkProcessor("video");
  checkProcessor("audio");
  if (inprocMode) {
    checkInprocWeights();
    inprocProbe = runInprocImportProbe();
  } else {
    checkVideoModelCommands();
    checkVoiceModelCommands();
  }
  if (endpointLive) endpointLiveReport = await checkEndpointLive();
  printReport();

  if (issues.length > 0 || (strict && warnings.length > 0)) process.exit(1);
}

function resolveEngineMode() {
  const explicit = (env.SHAPE_MODEL_ENDPOINT_ENGINE ?? "").trim().toLowerCase();
  if (
    ["inproc", "wrappers", "passthrough", "demo-effects"].includes(explicit)
  ) {
    return explicit;
  }
  if (
    envFlag("SHAPE_MODEL_ENDPOINT_PASSTHROUGH") ||
    wrapperPassthroughEnabled()
  ) {
    return "passthrough";
  }
  if (envFlag("SHAPE_MODEL_ENDPOINT_DEMO_EFFECTS")) return "demo-effects";
  return "wrappers";
}

function envFlag(name) {
  return /^(1|true|yes|on)$/i.test(env[name] ?? "");
}

function checkBaseFiles() {
  const wrapperPaths = [
    "apps/ai-sidecar/server.py",
    "apps/ai-sidecar/processors/shape_processor_command.py",
    "apps/ai-sidecar/wrappers/facefusion_frame.py",
    "apps/ai-sidecar/wrappers/backgroundmattingv2_frame.py",
    "apps/ai-sidecar/wrappers/vcclient000_chunk.py",
  ];
  if (inprocMode) {
    wrapperPaths.push(
      "apps/ai-sidecar/processors/shape_model_endpoint_server.py",
      "apps/ai-sidecar/engines/__init__.py",
      "apps/ai-sidecar/engines/runtime.py",
      "apps/ai-sidecar/engines/face_insightface.py",
      "apps/ai-sidecar/engines/background_matting.py",
      "apps/ai-sidecar/engines/voice_wokada.py",
      "apps/ai-sidecar/requirements-inproc-cuda.txt",
      "apps/ai-sidecar/requirements-inproc-mac.txt",
    );
  }

  for (const path of wrapperPaths) {
    if (!existsSync(join(repoRoot, path))) issue(`Falta ${path}.`);
  }

  ok(
    inprocMode
      ? "contrato local de sidecar, model endpoint y engines inproc presentes"
      : "contrato local de sidecar y wrappers presentes",
  );

  // In inproc mode the CLI wrappers are the `wrappers` fallback, not the hot
  // path; their CLI smoke is not a requirement for the persistent runtime.
  if (!skipWrapperSmoke && !inprocMode) {
    checkWrapperCliSmoke(
      "FaceFusion wrapper",
      "apps/ai-sidecar/wrappers/facefusion_frame.py",
    );
    checkWrapperCliSmoke(
      "BackgroundMattingV2 wrapper",
      "apps/ai-sidecar/wrappers/backgroundmattingv2_frame.py",
    );
    checkWrapperCliSmoke(
      "vcclient000 wrapper",
      "apps/ai-sidecar/wrappers/vcclient000_chunk.py",
    );
  }
}

function checkRuntimeEnv() {
  if (existsSync(envFile)) {
    ok(`runtime env encontrado: ${envFile}`);
    return;
  }

  warn(
    [
      `No existe runtime env de modelos: ${envFile}`,
      "Generalo con `pnpm models:runtime -- --preset local-wrappers --passthrough` o con comandos reales.",
    ].join(" "),
  );
  nextStep(
    `Genera runtime local: ${runtimeCommandForProfile(workstationProfile)}`,
  );
}

function checkHardware() {
  ok(`plataforma: ${platform()} ${process.arch}`);

  const nvidia = spawnSync(
    "nvidia-smi",
    [
      "--query-gpu=name,memory.total,driver_version",
      "--format=csv,noheader,nounits",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  if (nvidia.status === 0 && nvidia.stdout.trim()) {
    const gpus = parseNvidiaSmiCsv(nvidia.stdout);
    nvidiaAvailable = true;
    hardware.gpuRuntime = "cuda";
    hardware.gpus = gpus;
    hardware.readyForLocalModels = gpus.some((gpu) => gpu.readyForDemo);
    hardware.status = hardware.readyForLocalModels ? "ready" : "limited";
    hardware.message = hardware.readyForLocalModels
      ? "GPU NVIDIA compatible detectada para modelos locales."
      : "NVIDIA detectada, pero no parece RTX 4070+ para el demo IA real.";
    hardware.warnings = gpus.flatMap((gpu) => gpu.warnings);
    ok(`NVIDIA detectada: ${firstLine(nvidia.stdout)}`);
    for (const warning of hardware.warnings) warn(warning);
    if (!hardware.readyForLocalModels) {
      nextStep(
        "Valida el demo real en una workstation RTX 4070 o superior; esta máquina puede abrir la app pero quizá no sostenga IA local.",
      );
    }
    return;
  }

  if (platform() === "darwin" && process.arch === "arm64") {
    hardware.gpuRuntime = "apple-silicon";
    hardware.status =
      workstationProfile === "apple-silicon" ? "limited" : "profile-mismatch";
    hardware.readyForLocalModels = workstationProfile === "apple-silicon";
    hardware.message =
      workstationProfile === "apple-silicon"
        ? "Apple Silicon detectado; valida motores MPS/CoreML específicos antes del demo real."
        : "Apple Silicon detectado con perfil no Apple Silicon.";
    hardware.warnings.push(
      "Apple Silicon no tiene CUDA; usa comandos/modelos compatibles con Metal/MPS para esta máquina.",
    );
    for (const warning of hardware.warnings) warn(warning);
    return;
  }

  hardware.gpuRuntime = "none";
  hardware.status = "missing";
  hardware.readyForLocalModels = false;
  hardware.message =
    "No se detectó NVIDIA CUDA ni Apple Silicon; esta máquina sirve para abrir la app, no para demo IA local real.";
  hardware.issues.push("GPU local compatible no detectada.");
  warn(
    "No se detectó `nvidia-smi`. Las rutas FaceFusion/BMV2 con CUDA deben validarse en la máquina NVIDIA final.",
  );
  nextStep(
    "En Windows/NVIDIA instala drivers RTX/CUDA, reinicia terminal y confirma `nvidia-smi` antes del demo real.",
  );
}

function checkProcessor(kind) {
  const prefix = kind === "video" ? "SHAPE_VIDEO" : "SHAPE_AUDIO";
  const command = env[`${prefix}_PROCESSOR_COMMAND`];
  const endpoint = env[`${prefix}_PROCESSOR_ENDPOINT`];
  const healthUrl = env[`${prefix}_PROCESSOR_HEALTH_URL`];
  const defaultPort = kind === "video" ? "7860" : "7861";

  if (inprocMode) {
    // Collapsed hops: server.py posts straight at the model endpoint (:9100);
    // a *_PROCESSOR_COMMAND would resurrect the shape_processor_command hop.
    const expectedPath = kind === "video" ? "/process-frame" : "/process-audio";
    if (command) {
      warn(
        `${prefix}_PROCESSOR_COMMAND configurado en modo inproc; el runtime ` +
          "colapsado no debe definirlo (server.py postea directo al model endpoint).",
      );
    } else {
      ok(`${prefix}_PROCESSOR_COMMAND ausente (saltos colapsados)`);
    }
    if (!endpoint) {
      issue(
        `${prefix}_PROCESSOR_ENDPOINT no configurado; en modo inproc debe ` +
          `apuntar a ${expectedPath} del model endpoint (:9100).`,
      );
    } else {
      checkUrl(endpoint, `${prefix}_PROCESSOR_ENDPOINT`);
      if (validHttpUrl(endpoint)) {
        const path = new URL(endpoint).pathname.replace(/\/+$/, "");
        if (path !== expectedPath) {
          warn(
            `${prefix}_PROCESSOR_ENDPOINT no termina en ${expectedPath}; ` +
              "el contrato colapsado del model endpoint usa esa ruta.",
          );
        }
      }
    }
    if (!healthUrl) {
      warn(`${prefix}_PROCESSOR_HEALTH_URL no configurado.`);
    } else {
      checkUrl(healthUrl, `${prefix}_PROCESSOR_HEALTH_URL`);
    }
    return;
  }

  if (!command) {
    warn(
      `${prefix}_PROCESSOR_COMMAND no configurado; ` +
        `models:runtime debe apuntar a shape_processor_command.py --kind ${kind} --port ${defaultPort}.`,
    );
  } else {
    checkCommandExecutable(command, `${prefix}_PROCESSOR_COMMAND`);
    ok(`${prefix}_PROCESSOR_COMMAND configurado`);
  }

  if (!endpoint) {
    warn(`${prefix}_PROCESSOR_ENDPOINT no configurado.`);
  } else {
    checkUrl(endpoint, `${prefix}_PROCESSOR_ENDPOINT`);
  }

  if (!healthUrl) {
    warn(`${prefix}_PROCESSOR_HEALTH_URL no configurado.`);
  } else {
    checkUrl(healthUrl, `${prefix}_PROCESSOR_HEALTH_URL`);
  }
}

function checkVideoModelCommands() {
  const combined = env.SHAPE_VIDEO_FRAME_COMMAND;
  const combinedEndpoint = env.SHAPE_VIDEO_FRAME_ENDPOINT;
  const face = env.SHAPE_FACE_COMMAND;
  const faceEndpoint = env.SHAPE_FACE_ENDPOINT;
  const background = env.SHAPE_BACKGROUND_COMMAND;
  const backgroundEndpoint = env.SHAPE_BACKGROUND_ENDPOINT;

  if (combined) {
    checkModelCommand(combined, "SHAPE_VIDEO_FRAME_COMMAND", [
      "input",
      "output",
    ]);
    if (!combined.includes("{identity}")) {
      warn(
        "SHAPE_VIDEO_FRAME_COMMAND no usa {identity}; el face swap podría no recibir el rostro.",
      );
    }
    if (!combined.includes("{clean_plate}")) {
      warn(
        "SHAPE_VIDEO_FRAME_COMMAND no usa {clean_plate}; BackgroundMattingV2 podría no recibir referencia.",
      );
    }
    ok("wrapper combinado de video configurado");
    return;
  }

  if (combinedEndpoint) {
    checkUrl(combinedEndpoint, "SHAPE_VIDEO_FRAME_ENDPOINT");
    ok("endpoint combinado de video configurado");
    return;
  }

  checkFaceCommand(face, faceEndpoint);
  checkBackgroundCommand(background, backgroundEndpoint);
}

function checkFaceCommand(command, endpoint) {
  if (!command) {
    if (endpoint) {
      checkUrl(endpoint, "SHAPE_FACE_ENDPOINT");
      ok("endpoint de face swap configurado");
    } else {
      warn("SHAPE_FACE_COMMAND/SHAPE_FACE_ENDPOINT no configurado.");
    }
    return;
  }

  checkModelCommand(command, "SHAPE_FACE_COMMAND", [
    "input",
    "output",
    "identity",
  ]);
  ok("comando de face swap configurado");

  if (command.includes("facefusion_frame.py")) {
    checkFaceFusionWrapper();
  }
}

function checkBackgroundCommand(command, endpoint) {
  if (!command) {
    if (endpoint) {
      checkUrl(endpoint, "SHAPE_BACKGROUND_ENDPOINT");
      ok("endpoint de matting/fondo configurado");
    } else {
      warn(
        "SHAPE_BACKGROUND_COMMAND/SHAPE_BACKGROUND_ENDPOINT no configurado.",
      );
    }
    return;
  }

  checkModelCommand(command, "SHAPE_BACKGROUND_COMMAND", [
    "input",
    "output",
    "clean_plate",
  ]);
  ok("comando de matting/fondo configurado");

  if (command.includes("backgroundmattingv2_frame.py")) {
    checkBackgroundMattingWrapper();
  }
}

function checkVoiceModelCommands() {
  const combined = env.SHAPE_AUDIO_CHUNK_COMMAND;
  const combinedEndpoint = env.SHAPE_AUDIO_CHUNK_ENDPOINT;
  const voice = env.SHAPE_VOICE_COMMAND;
  const voiceEndpoint = env.SHAPE_VOICE_ENDPOINT;

  if (combined) {
    checkModelCommand(combined, "SHAPE_AUDIO_CHUNK_COMMAND", [
      "input",
      "output",
      "sample_rate",
    ]);
    ok("wrapper combinado de audio configurado");
    return;
  }

  if (combinedEndpoint) {
    checkUrl(combinedEndpoint, "SHAPE_AUDIO_CHUNK_ENDPOINT");
    ok("endpoint combinado de audio configurado");
    return;
  }

  if (!voice) {
    if (voiceEndpoint) {
      checkUrl(voiceEndpoint, "SHAPE_VOICE_ENDPOINT");
      ok("endpoint de voz configurado");
    } else {
      warn("SHAPE_VOICE_COMMAND/SHAPE_VOICE_ENDPOINT no configurado.");
    }
    return;
  }

  checkModelCommand(voice, "SHAPE_VOICE_COMMAND", [
    "input",
    "output",
    "sample_rate",
  ]);
  ok("comando de voz configurado");

  if (voice.includes("vcclient000_chunk.py")) {
    checkVcClientWrapper();
  }
}

// --- inproc mode (persistent runtime) ------------------------------------------

function backgroundEngineInproc() {
  // Mirrors engines/background_matting.create_background_engine().
  const value = (env.SHAPE_BACKGROUND_ENGINE ?? "rvm").trim().toLowerCase();
  return ["bmv2", "backgroundmattingv2", "bgmv2"].includes(value)
    ? "bmv2"
    : "rvm";
}

function insightfaceHomePath() {
  return (
    pathValue("SHAPE_INSIGHTFACE_HOME") ??
    pathValue("INSIGHTFACE_HOME") ??
    join(homedir(), ".insightface")
  );
}

function inprocVoiceEndpoint() {
  // Mirrors engines/voice_wokada.VoiceEngine.load().
  return env.VCCLIENT000_HTTP_ENDPOINT ?? env.SHAPE_VOICE_ENDPOINT ?? null;
}

function checkInprocWeights() {
  if (
    wrapperPassthroughEnabled() ||
    envFlag("SHAPE_MODEL_ENDPOINT_PASSTHROUGH")
  ) {
    warn(
      "Passthrough activo junto con engine inproc; el engine inproc lo ignora, " +
        "limpia SHAPE_WRAPPER_PASSTHROUGH/SHAPE_MODEL_ENDPOINT_PASSTHROUGH.",
    );
  }

  const inswapper = pathValue("SHAPE_INSWAPPER_MODEL");
  if (!inswapper) {
    issue(
      "SHAPE_INSWAPPER_MODEL no configurado; el modo inproc requiere inswapper_128.onnx.",
    );
    nextStep(
      "Descarga inswapper_128.onnx (modelo gated de InsightFace, no redistribuible) y apunta SHAPE_INSWAPPER_MODEL a su ruta.",
    );
  } else if (!existsSync(inswapper) || statSync(inswapper).size <= 0) {
    issue(`SHAPE_INSWAPPER_MODEL no existe o está vacío: ${inswapper}`);
    nextStep(
      "Descarga inswapper_128.onnx (modelo gated de InsightFace, no redistribuible) y apunta SHAPE_INSWAPPER_MODEL a su ruta.",
    );
  } else {
    ok(`inswapper_128.onnx listo: ${inswapper}`);
  }

  const insightfaceHome = insightfaceHomePath();
  if (existsSync(join(insightfaceHome, "models", "buffalo_l"))) {
    ok(`buffalo_l en cache insightface: ${insightfaceHome}`);
  } else {
    warn(
      `buffalo_l no está en ${insightfaceHome}; insightface lo descargará en el ` +
        "primer arranque (usa el warm-up del bootstrap para pagarlo en instalación).",
    );
  }

  const backgroundEngine = backgroundEngineInproc();
  if (backgroundEngine === "bmv2") {
    const checkpoint = pathValue("BMV2_MODEL_CHECKPOINT");
    if (
      !checkpoint ||
      !existsSync(checkpoint) ||
      statSync(checkpoint).size <= 0
    ) {
      issue(
        `BMV2_MODEL_CHECKPOINT no existe o está vacío: ${checkpoint ?? "sin configurar"} ` +
          "(SHAPE_BACKGROUND_ENGINE=bmv2 requiere checkpoint torchscript).",
      );
      nextStep(
        "Descarga el checkpoint torchscript de BackgroundMattingV2 o cambia a SHAPE_BACKGROUND_ENGINE=rvm.",
      );
    } else {
      ok(`BMV2 checkpoint torchscript listo: ${checkpoint}`);
    }
  } else {
    const rvm = pathValue("SHAPE_RVM_MODEL");
    if (!rvm || !existsSync(rvm) || statSync(rvm).size <= 0) {
      issue(
        `SHAPE_RVM_MODEL no existe o está vacío: ${rvm ?? "sin configurar"} ` +
          "(el fondo inproc usa RVM por defecto).",
      );
      nextStep(
        "Descarga rvm_mobilenetv3_fp32.torchscript (MIT, release oficial PeterL1n/RobustVideoMatting) y apunta SHAPE_RVM_MODEL a su ruta.",
      );
    } else {
      ok(`modelo RVM listo: ${rvm}`);
    }
  }

  if (managedVoiceEnabled()) {
    // Managed runtime: the endpoint server supervises VCClient itself, so the
    // presence of a live external endpoint is irrelevant. Validate the dist.
    checkManagedVoiceRuntime();
    return;
  }

  const voiceEndpoint = inprocVoiceEndpoint();
  if (!voiceEndpoint) {
    issue(
      "VCCLIENT000_HTTP_ENDPOINT no configurado; el cliente persistente de voz habla con VCClient/w-okada (v2 convert_chunk o v1 /test, VCCLIENT000_HTTP_MODE=auto detecta cuál).",
    );
    nextStep(
      "Arranca VCClient con un slot RVC cargado y configura VCCLIENT000_HTTP_ENDPOINT=http://127.0.0.1:18000 (v2, default) o http://127.0.0.1:18888/test (w-okada v1 legado). O activa el runtime gestionado: VCCLIENT000_MANAGED=1 + VCCLIENT000_DIST_DIR.",
    );
  } else {
    checkUrl(voiceEndpoint, "VCCLIENT000_HTTP_ENDPOINT");
  }
}

function managedVoiceEnabled() {
  return envFlag("VCCLIENT000_MANAGED");
}

function checkManagedVoiceRuntime() {
  const distDir = env.VCCLIENT000_DIST_DIR?.trim();
  if (!distDir) {
    issue(
      "VCCLIENT000_MANAGED=1 pero VCCLIENT000_DIST_DIR no está configurado (dir con el binario main de VCClient).",
    );
    nextStep(
      "Configura VCCLIENT000_DIST_DIR al dir dist de VCClient v2 (contiene main/main.exe, model_dir, settings).",
    );
    return;
  }

  const resolvedDist = resolvePath(distDir);
  const binaryName = platform() === "win32" ? "main.exe" : "main";
  const binaryPath = join(resolvedDist, binaryName);
  if (!existsSync(binaryPath)) {
    issue(
      `binario VCClient no encontrado: ${binaryPath} (VCCLIENT000_MANAGED requiere el dist real presente).`,
    );
    nextStep(
      "Instala/descarga el dist de VCClient v2 y apunta VCCLIENT000_DIST_DIR a su carpeta (con main y model_dir).",
    );
    return;
  }

  if (platform() !== "win32") {
    try {
      accessSync(binaryPath, fsConstants.X_OK);
    } catch {
      issue(
        `binario VCClient no es ejecutable: ${binaryPath} (chmod +x y quita la cuarentena).`,
      );
      nextStep(
        "Hazlo ejecutable y quita la cuarentena (macOS): chmod +x main; xattr -dr com.apple.quarantine <dist>.",
      );
      return;
    }
  }

  const port = env.VCCLIENT000_PORT?.trim() || "18000";
  ok(`VCClient gestionado: binario listo ${binaryPath} (puerto ${port}).`);

  const modelDir = join(resolvedDist, "model_dir");
  if (existsSync(modelDir)) {
    ok(`VCClient model_dir presente: ${modelDir}`);
  } else {
    warn(
      `VCClient model_dir no existe en ${resolvedDist}; el primer arranque descargará módulos/modelos (~2 GB). Pre-siembra el dist para evitar la espera.`,
    );
  }
}

function inprocPythonCommand() {
  // Mirrors how the endpoint python is resolved (run-model-endpoint-server.mjs
  // and scripts/support/inproc-smoke.mjs): explicit env, then the inproc venv,
  // then the platform python.
  const explicit = env.SHAPE_MODEL_ENDPOINT_PYTHON || env.SHAPE_AI_PYTHON;
  if (explicit) return explicit;
  const venvPython = join(
    repoRoot,
    "apps",
    "ai-sidecar",
    ".venv-inproc",
    ...(process.platform === "win32"
      ? ["Scripts", "python.exe"]
      : ["bin", "python"]),
  );
  if (existsSync(venvPython)) return venvPython;
  return defaultPython();
}

function runInprocImportProbe() {
  const python = inprocPythonCommand();
  const probe = {
    python,
    ok: false,
    modules: {},
    providers: [],
    error: null,
  };
  const code = [
    "import json",
    "report = {'modules': {}, 'providers': []}",
    "for mod in ('numpy', 'cv2', 'onnxruntime', 'insightface', 'torch'):",
    "    try:",
    "        __import__(mod)",
    "        report['modules'][mod] = True",
    "    except Exception as error:",
    "        report['modules'][mod] = str(error)[:160]",
    "try:",
    "    import onnxruntime",
    "    report['providers'] = list(onnxruntime.get_available_providers())",
    "except Exception:",
    "    pass",
    "print(json.dumps(report))",
  ].join("\n");

  const result = spawnSync(python, ["-c", code], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000,
    shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(python),
  });

  const lastLine = (result.stdout ?? "")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .pop();
  let parsed = null;
  if (result.status === 0 && lastLine) {
    try {
      parsed = JSON.parse(lastLine);
    } catch {
      parsed = null;
    }
  }

  if (!parsed) {
    probe.error = [result.stderr, result.stdout]
      .filter(Boolean)
      .join("\n")
      .trim()
      .slice(0, 300);
    warn(
      `probe de imports inproc no ejecutó con ${python}: ${probe.error || `status ${result.status}`}`,
    );
    nextStep(
      "Crea el venv del endpoint: python3 -m venv apps/ai-sidecar/.venv-inproc && pip install -r apps/ai-sidecar/requirements-inproc-mac.txt (o -cuda en Windows/NVIDIA).",
    );
    return probe;
  }

  probe.modules = parsed.modules ?? {};
  probe.providers = Array.isArray(parsed.providers) ? parsed.providers : [];
  const required = ["numpy", "cv2", "onnxruntime", "insightface", "torch"];
  const missing = required.filter((mod) => probe.modules[mod] !== true);
  probe.ok = missing.length === 0;

  if (probe.ok) {
    ok(
      `imports inproc ok con ${python} (providers: ${probe.providers.join(", ") || "ninguno"})`,
    );
  } else {
    warn(
      `faltan imports inproc (${missing.join(", ")}) con ${python}; instala ` +
        "apps/ai-sidecar/requirements-inproc-{mac,cuda}.txt en el venv del endpoint.",
    );
    nextStep(
      "Instala las dependencias inproc en el venv del endpoint (requirements-inproc-mac.txt / requirements-inproc-cuda.txt).",
    );
  }

  if (
    workstationProfile === "windows-nvidia" &&
    probe.modules.onnxruntime === true &&
    !probe.providers.includes("CUDAExecutionProvider")
  ) {
    warn(
      "onnxruntime sin CUDAExecutionProvider en perfil windows-nvidia; instala onnxruntime-gpu (requirements-inproc-cuda.txt).",
    );
  }
  if (
    workstationProfile === "apple-silicon" &&
    probe.modules.onnxruntime === true &&
    !probe.providers.some((provider) =>
      ["CoreMLExecutionProvider", "CPUExecutionProvider"].includes(provider),
    )
  ) {
    warn("onnxruntime no reporta CoreML/CPU providers en Apple Silicon.");
  }

  return probe;
}

function modelEndpointDiagnosticsUrl() {
  // Mirrors apps/ai-sidecar/server.py model_endpoint_diagnostics_url().
  const explicit = env.SHAPE_MODEL_ENDPOINT_URL?.trim();
  if (explicit) {
    try {
      const url = new URL(explicit);
      if (!url.pathname.endsWith("/diagnostics")) {
        url.pathname = `${url.pathname.replace(/\/+$/, "")}/diagnostics`;
      }
      url.search = "";
      url.hash = "";
      return url.href;
    } catch {
      return null;
    }
  }

  const host = env.SHAPE_MODEL_ENDPOINT_HOST?.trim();
  const port = env.SHAPE_MODEL_ENDPOINT_PORT?.trim();
  if (host && port) return `http://${host}:${port}/diagnostics`;

  const derivablePaths = [
    "/process-frame",
    "/process-audio",
    "/video-frame",
    "/face",
    "/background",
    "/voice",
  ];
  for (const key of [
    "SHAPE_VIDEO_PROCESSOR_ENDPOINT",
    "SHAPE_AUDIO_PROCESSOR_ENDPOINT",
    "SHAPE_VIDEO_FRAME_ENDPOINT",
    "SHAPE_FACE_ENDPOINT",
    "SHAPE_BACKGROUND_ENDPOINT",
    "SHAPE_AUDIO_CHUNK_ENDPOINT",
    "SHAPE_VOICE_ENDPOINT",
  ]) {
    const value = env[key]?.trim();
    if (!value || !validHttpUrl(value)) continue;
    const url = new URL(value);
    if (!derivablePaths.includes(url.pathname.replace(/\/+$/, ""))) continue;
    url.pathname = "/diagnostics";
    url.search = "";
    url.hash = "";
    return url.href;
  }

  return null;
}

async function checkEndpointLive() {
  const url = modelEndpointDiagnosticsUrl();
  const report = {
    url,
    ok: false,
    ready: null,
    mode: null,
    device: null,
    stages: [],
  };

  if (!url) {
    issue(
      "--endpoint-live: no se pudo resolver la URL del model endpoint; define SHAPE_MODEL_ENDPOINT_URL o SHAPE_MODEL_ENDPOINT_HOST/PORT.",
    );
    return report;
  }

  let data = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) {
      issue(`--endpoint-live: ${url} devolvió HTTP ${response.status}.`);
      return report;
    }
    data = await response.json();
  } catch (error) {
    issue(
      `--endpoint-live: model endpoint no accesible en ${url} (${error?.name || error?.message || error}). Arranca \`pnpm models:endpoint\` con el runtime env cargado.`,
    );
    return report;
  }

  const diagnostics =
    data && typeof data === "object" && data.diagnostics
      ? data.diagnostics
      : data;
  report.ok = true;
  report.ready = Boolean(diagnostics?.ready);
  report.mode = diagnostics?.mode ?? null;
  const runtime =
    diagnostics?.runtime && typeof diagnostics.runtime === "object"
      ? diagnostics.runtime
      : {};
  report.device = runtime.device ?? null;

  ok(
    `endpoint vivo: ${url} (mode=${report.mode ?? "?"}, ready=${report.ready})`,
  );
  if (inprocMode && report.mode !== "inproc") {
    warn(
      `endpoint vivo corre mode=${report.mode ?? "?"}, pero el runtime env pide engine inproc.`,
    );
  }
  if (inprocMode) {
    if (report.device) {
      ok(`runtime.device del endpoint: ${report.device}`);
    } else {
      warn(
        "endpoint vivo sin runtime.device (motores aún cargando o mode distinto de inproc).",
      );
    }
  }

  const stages = Array.isArray(diagnostics?.stages) ? diagnostics.stages : [];
  for (const stage of stages) {
    const engine =
      stage?.engine && typeof stage.engine === "object" ? stage.engine : null;
    const state = engine?.state ?? null;
    report.stages.push({
      id: stage?.id ?? null,
      state,
      reason: engine?.reason ?? null,
      device: engine?.device ?? null,
    });
    if (!state) continue;
    if (state === "failed") {
      issue(
        `endpoint stage ${stage.id} failed: ${engine?.reason ?? "sin reason"}${engine?.detail ? ` (${engine.detail})` : ""}`,
      );
    } else if (state === "degraded") {
      warn(
        `endpoint stage ${stage.id} degraded: ${engine?.reason ?? "sin reason"}`,
      );
    } else {
      ok(`endpoint stage ${stage.id} active (${engine?.device ?? "device ?"})`);
    }
  }

  return report;
}

function checkFaceFusionWrapper() {
  const template = env.FACEFUSION_COMMAND_TEMPLATE;
  if (template) {
    checkModelCommand(template, "FACEFUSION_COMMAND_TEMPLATE", [
      "input",
      "output",
      "identity",
    ]);
    return;
  }

  const facefusionDir = pathValue("FACEFUSION_DIR");
  const entrypoint = pathValue("FACEFUSION_ENTRYPOINT") ?? "facefusion.py";
  const resolvedEntrypoint =
    facefusionDir && !isAbsolutePath(entrypoint)
      ? join(facefusionDir, entrypoint)
      : entrypoint;

  if (!facefusionDir) {
    warn(
      wrapperPassthroughEnabled()
        ? "FACEFUSION_DIR no configurado; passthrough de FaceFusion activo."
        : "FACEFUSION_DIR no configurado para el wrapper FaceFusion.",
    );
    nextStep(
      `Configura FACEFUSION_DIR y FACEFUSION_PYTHON o usa \`${runtimeCommandForProfile(workstationProfile)}\`.`,
    );
  } else if (!existsSync(facefusionDir)) {
    if (wrapperPassthroughEnabled()) {
      warn(`FACEFUSION_DIR no existe: ${facefusionDir}; passthrough activo.`);
    } else {
      issue(`FACEFUSION_DIR no existe: ${facefusionDir}`);
    }
    nextStep(`Clona/instala FaceFusion en ${facefusionDir}.`);
  }

  if (!existsSync(resolvedEntrypoint)) {
    if (wrapperPassthroughEnabled()) {
      warn(
        `FaceFusion entrypoint no existe: ${resolvedEntrypoint}; passthrough activo.`,
      );
    } else {
      issue(`FaceFusion entrypoint no existe: ${resolvedEntrypoint}`);
    }
    nextStep(
      "Revisa FACEFUSION_ENTRYPOINT o actualiza el wrapper si tu versión de FaceFusion usa otro comando.",
    );
  } else {
    ok(`FaceFusion entrypoint listo: ${resolvedEntrypoint}`);
  }

  checkCommandExecutable(
    env.FACEFUSION_PYTHON ?? defaultPython(),
    "FACEFUSION_PYTHON",
  );

  if (
    (env.FACEFUSION_EXECUTION_PROVIDERS ?? "cuda").includes("cuda") &&
    !nvidiaAvailable &&
    !skipHardware
  ) {
    warn(
      "FACEFUSION_EXECUTION_PROVIDERS incluye cuda, pero `nvidia-smi` no está disponible.",
    );
  }
}

function checkBackgroundMattingWrapper() {
  const template = env.BMV2_COMMAND_TEMPLATE;
  if (template) {
    checkModelCommand(template, "BMV2_COMMAND_TEMPLATE", [
      "input",
      "output",
      "clean_plate",
    ]);
    return;
  }

  const repoDir = pathValue("BMV2_REPO_DIR");
  const checkpoint = pathValue("BMV2_MODEL_CHECKPOINT");

  if (!repoDir) {
    warn(
      wrapperPassthroughEnabled()
        ? "BMV2_REPO_DIR no configurado; passthrough de BackgroundMattingV2 activo."
        : "BMV2_REPO_DIR no configurado para BackgroundMattingV2.",
    );
    nextStep(
      "Configura BMV2_REPO_DIR, BMV2_PYTHON y BMV2_MODEL_CHECKPOINT para activar cambio de fondo real.",
    );
  } else if (!existsSync(join(repoDir, "inference_images.py"))) {
    if (wrapperPassthroughEnabled()) {
      warn(
        `BMV2_REPO_DIR no contiene inference_images.py: ${repoDir}; passthrough activo.`,
      );
    } else {
      issue(`BMV2_REPO_DIR no contiene inference_images.py: ${repoDir}`);
    }
    nextStep(`Clona BackgroundMattingV2 en ${repoDir}.`);
  } else {
    ok(`BackgroundMattingV2 repo listo: ${repoDir}`);
  }

  if (!checkpoint) {
    warn(
      wrapperPassthroughEnabled()
        ? "BMV2_MODEL_CHECKPOINT no configurado; passthrough de BackgroundMattingV2 activo."
        : "BMV2_MODEL_CHECKPOINT no configurado.",
    );
    nextStep(
      "Configura BMV2_MODEL_CHECKPOINT con el checkpoint de BackgroundMattingV2 antes de probar fondo real.",
    );
  } else if (!existsSync(checkpoint) || statSync(checkpoint).size <= 0) {
    if (wrapperPassthroughEnabled()) {
      warn(
        `BMV2_MODEL_CHECKPOINT no existe o está vacío: ${checkpoint}; passthrough activo.`,
      );
    } else {
      issue(`BMV2_MODEL_CHECKPOINT no existe o está vacío: ${checkpoint}`);
    }
    nextStep(
      `Descarga el checkpoint BackgroundMattingV2 esperado en ${checkpoint}.`,
    );
  } else {
    ok(`BackgroundMattingV2 checkpoint listo: ${checkpoint}`);
  }

  checkCommandExecutable(env.BMV2_PYTHON ?? defaultPython(), "BMV2_PYTHON");

  if (
    (env.BMV2_DEVICE ?? "cuda") === "cuda" &&
    !nvidiaAvailable &&
    !skipHardware
  ) {
    warn("BMV2_DEVICE=cuda, pero `nvidia-smi` no está disponible.");
  }
}

function checkVcClientWrapper() {
  const commandTemplate = env.VCCLIENT000_CHUNK_COMMAND;
  const endpoint = env.VCCLIENT000_HTTP_ENDPOINT;
  const httpMode = normalizeVcClientHttpMode(env.VCCLIENT000_HTTP_MODE);

  if (commandTemplate) {
    checkModelCommand(commandTemplate, "VCCLIENT000_CHUNK_COMMAND", [
      "input",
      "output",
      "sample_rate",
    ]);
    return;
  }

  if (endpoint) {
    checkUrl(endpoint, "VCCLIENT000_HTTP_ENDPOINT");
    ok(`vcclient000 HTTP endpoint configurado (${httpMode})`);
    checkVcClientEndpointShape(endpoint, httpMode);
    return;
  }

  warn(
    "vcclient000 wrapper requiere VCCLIENT000_CHUNK_COMMAND o VCCLIENT000_HTTP_ENDPOINT.",
  );
  nextStep(
    "Arranca VCClient/w-okada localmente y configura VCCLIENT000_HTTP_ENDPOINT=http://127.0.0.1:18000 (v2, default) o http://127.0.0.1:18888/test (w-okada v1 legado).",
  );
}

function normalizeVcClientHttpMode(value) {
  const mode = (value || "auto").trim().toLowerCase().replace(/_/g, "-");
  if (
    ["vcclient2", "vcclient-v2", "w-okada-v2", "wokada-v2", "v2"].includes(mode)
  )
    return "vcclient2";
  if (["w-okada", "w-okada-rest", "vcclient", "vcclient-rest"].includes(mode))
    return "w-okada-rest";
  if (["shape", "shape-json", "shape-meet"].includes(mode)) return "shape-json";
  return mode || "auto";
}

function checkVcClientEndpointShape(endpoint, httpMode) {
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    return;
  }

  const path = parsed.pathname.replace(/\/+$/, "");
  const looksLikeV1 = path === "" || path === "/test";
  const looksLikeV2 = path.endsWith("/api/voice-changer/convert_chunk");

  if (httpMode === "w-okada-rest" && !looksLikeV1) {
    warn(
      "VCCLIENT000_HTTP_MODE=w-okada-rest usa el REST v1 legado de w-okada; normalmente el endpoint es http://127.0.0.1:18888/test o la URL base.",
    );
  }

  if (httpMode === "vcclient2" && !looksLikeV2) {
    warn(
      "VCCLIENT000_HTTP_MODE=vcclient2 habla POST /api/voice-changer/convert_chunk; normalmente el endpoint es la URL base de VCClient (p.ej. http://127.0.0.1:18000), el path se completa solo.",
    );
  }

  if (httpMode === "auto" && !looksLikeV1 && !looksLikeV2) {
    warn(
      "VCCLIENT000_HTTP_ENDPOINT no termina en /test ni en /api/voice-changer/convert_chunk y VCCLIENT000_HTTP_MODE está en auto; se tratará como endpoint Shape JSON. Para VCClient v2 (default) usa la URL base con modo auto/vcclient2; para w-okada v1 usa VCCLIENT000_HTTP_MODE=w-okada-rest.",
    );
  }
}

function wrapperPassthroughEnabled() {
  return /^(1|true|yes|on)$/i.test(env.SHAPE_WRAPPER_PASSTHROUGH ?? "");
}

function checkModelCommand(command, label, placeholders) {
  checkCommandExecutable(command, label);

  for (const placeholder of placeholders) {
    if (!command.includes(`{${placeholder}}`)) {
      issue(`${label} debe incluir placeholder {${placeholder}}.`);
    }
  }
}

function checkCommandExecutable(command, label) {
  const result = commandExecutableStatus(command);
  if (!result.ok) {
    issue(`${label} ${result.message}`);
    return;
  }

  ok(`${label} ${result.message}`);
}

function commandExecutableStatus(command) {
  const executable = commandExecutable(command);
  if (!executable)
    return { ok: false, message: "no tiene ejecutable detectable." };

  if (isPathLike(executable)) {
    const resolved = resolvePath(executable);
    if (!existsSync(resolved)) {
      return { ok: false, message: `ejecutable no existe: ${resolved}` };
    }
    return { ok: true, message: `ejecutable disponible: ${resolved}` };
  }

  const result = spawnSync(executable, ["--version"], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: process.platform === "win32" && /\.cmd$/i.test(executable),
  });
  if (result.status !== 0 && !which(executable)) {
    return {
      ok: false,
      message: `ejecutable no disponible en PATH: ${executable}`,
    };
  }

  return { ok: true, message: `ejecutable disponible: ${executable}` };
}

function checkWrapperCliSmoke(label, wrapperPath) {
  const fullPath = join(repoRoot, wrapperPath);
  if (!existsSync(fullPath)) return;

  const result = spawnSync(defaultPython(), [fullPath, "--help"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 10_000,
  });

  if (result.status === 0 && result.stdout.includes("usage:")) {
    ok(`${label} CLI carga correctamente`);
    return;
  }

  const detail = [result.stderr, result.stdout]
    .filter(Boolean)
    .join("\n")
    .trim()
    .slice(0, 400);
  issue(`${label} CLI no carga con ${defaultPython()} --help: ${detail}`);
}

function commandExecutable(command) {
  return splitCommand(command)[0] ?? "";
}

function splitCommand(command) {
  const parts = [];
  let current = "";
  let quote = null;
  let escaped = false;

  for (const char of String(command)) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current) parts.push(current);
  return parts;
}

function checkUrl(value, label) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) {
      issue(`${label} debe usar http(s): ${value}`);
      return;
    }
    ok(`${label} válido: ${value}`);
  } catch {
    issue(`${label} no es URL válida: ${value}`);
  }
}

function which(command) {
  const result = spawnSync(
    process.platform === "win32" ? "where" : "which",
    [command],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  return result.status === 0;
}

function pathValue(key) {
  const value = env[key]?.trim();
  return value ? resolvePath(value) : null;
}

function resolvePath(value) {
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  if (isAbsolutePath(value)) return value;
  return resolve(repoRoot, value);
}

function isAbsolutePath(value) {
  return /^([A-Za-z]:[\\/]|\/|\\\\)/.test(value);
}

function isPathLike(value) {
  return (
    value.includes("/") ||
    value.includes("\\") ||
    value.startsWith(".") ||
    /^[A-Za-z]:/.test(value)
  );
}

function defaultPython() {
  return process.platform === "win32" ? "python" : "python3";
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

function readEnvFile(path) {
  const fullPath = isAbsolutePath(path) ? path : join(repoRoot, path);
  if (!existsSync(fullPath)) return {};
  const values = {};

  for (const rawLine of readFileSync(fullPath, "utf8").split(/\r?\n/)) {
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

function firstLine(value) {
  return String(value).trim().split(/\r?\n/)[0] ?? "";
}

function parseNvidiaSmiCsv(output) {
  return String(output)
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const [name = "", memoryRaw = "", driverVersion = ""] = line
        .split(",")
        .map((part) => part.trim());
      const memoryTotalMb = Number.parseInt(memoryRaw, 10);
      const generation = rtxGeneration(name);
      const modelTier = rtxModelTier(name);
      const readyByModel =
        generation !== null &&
        modelTier !== null &&
        ((generation === 40 && modelTier >= 70) ||
          (generation >= 50 && modelTier >= 70));
      const readyByMemory = Number.isFinite(memoryTotalMb)
        ? memoryTotalMb >= 8_000
        : true;
      const warnings = [];

      if (!readyByModel) {
        warnings.push(
          `${name || "GPU NVIDIA"} no parece RTX 4070/4080/4090/5070/5080/5090.`,
        );
      }
      if (!readyByMemory) {
        warnings.push(
          `${name || "GPU NVIDIA"} reporta ${memoryTotalMb} MB VRAM; 8 GB es el mínimo práctico para demo 720p30.`,
        );
      }

      return {
        name,
        memoryTotalMb: Number.isFinite(memoryTotalMb) ? memoryTotalMb : null,
        driverVersion,
        generation,
        modelTier,
        readyForDemo: readyByModel && readyByMemory,
        warnings,
      };
    })
    .filter((gpu) => gpu.name || gpu.memoryTotalMb || gpu.driverVersion);
}

function rtxGeneration(name) {
  const match = String(name).match(/\bRTX\s+(\d{2})(\d{2})(?:\s*Ti)?\b/i);
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

function rtxModelTier(name) {
  const match = String(name).match(/\bRTX\s+(\d{2})(\d{2})(?:\s*Ti)?\b/i);
  if (!match) return null;
  return Number.parseInt(match[2], 10);
}

function ok(message) {
  checks.push(message);
}

function warn(message) {
  warnings.push(message);
}

function issue(message) {
  issues.push(message);
}

function nextStep(message) {
  if (message && !nextSteps.includes(message)) nextSteps.push(message);
}

function printReport() {
  const hardwareReadiness = buildHardwareReadiness();
  const realModelReadiness = buildRealModelReadiness();

  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: issues.length === 0 && (!strict || warnings.length === 0),
          envFile,
          profile: workstationProfile,
          engine: engineMode,
          hardwareReadiness,
          realModelReadiness,
          inprocProbe,
          endpointLive: endpointLiveReport,
          checks,
          warnings,
          issues,
          nextSteps,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log("AI model doctor");
  console.log(`Runtime env: ${envFile}`);
  console.log(`Perfil: ${workstationProfile}`);
  console.log(`Engine: ${engineMode}`);
  console.log(
    `Hardware demo: ${hardwareReadiness.readyForLocalModels ? "listo" : hardwareReadiness.status}`,
  );
  console.log(`Hardware detalle: ${hardwareReadiness.message}`);
  console.log(
    `Modelos reales: ${realModelReadiness.ready ? "listos" : realModelReadiness.passthroughEnabled ? "passthrough" : "pendientes"}`,
  );
  for (const stage of realModelReadiness.stages) {
    console.log(`- ${stage.label}: ${stage.status}`);
    for (const currentIssue of stage.issues)
      console.log(`  error: ${currentIssue}`);
    for (const warning of stage.warnings) console.log(`  warn: ${warning}`);
  }
  for (const check of checks) console.log(`ok: ${check}`);
  for (const warning of warnings) console.warn(`warn: ${warning}`);
  for (const currentIssue of issues) console.error(`error: ${currentIssue}`);
  for (const step of nextSteps) console.log(`next: ${step}`);

  if (issues.length === 0 && (!strict || warnings.length === 0)) {
    console.log("AI model doctor ok");
  }
}

function buildHardwareReadiness() {
  return {
    ...hardware,
    checked: !skipHardware,
    profile: workstationProfile,
    recommendedMinimum: "RTX 4070 / Apple Silicon M-series",
    target: "RTX 4090/5090 para demo premium 720p30",
    blockers: hardware.issues,
    warnings: hardware.warnings,
  };
}

function buildRealModelReadiness() {
  if (inprocMode) return buildInprocModelReadiness();

  const passthroughEnabled = wrapperPassthroughEnabled();
  const stages = [
    buildProcessorReadiness("video"),
    buildFaceReadiness(),
    buildBackgroundReadiness(),
    buildProcessorReadiness("audio"),
    buildVoiceReadiness(),
  ];
  const ready =
    !passthroughEnabled &&
    stages.every(
      (stage) => stage.status === "ready" || stage.status === "optional",
    );

  return {
    ready,
    engine: engineMode,
    passthroughEnabled,
    profile: workstationProfile,
    envFile,
    stages,
    blockers: stages.flatMap((stage) =>
      stage.issues.map((message) => `${stage.label}: ${message}`),
    ),
    warnings: stages.flatMap((stage) =>
      stage.warnings.map((message) => `${stage.label}: ${message}`),
    ),
  };
}

function buildInprocModelReadiness() {
  // Ready in inproc mode = weights present + import probe passes + no
  // passthrough flags; the CLI repos (FACEFUSION_DIR/BMV2_REPO_DIR) are NOT
  // required because the hot path is in-process.
  const passthroughEnabled =
    wrapperPassthroughEnabled() || envFlag("SHAPE_MODEL_ENDPOINT_PASSTHROUGH");
  const stages = [
    buildInprocProcessorReadiness("video"),
    buildInprocFaceReadiness(),
    buildInprocBackgroundReadiness(),
    buildInprocProcessorReadiness("audio"),
    buildInprocVoiceReadiness(),
  ];
  const ready =
    !passthroughEnabled &&
    stages.every(
      (stage) => stage.status === "ready" || stage.status === "optional",
    );

  return {
    ready,
    engine: "inproc",
    passthroughEnabled,
    profile: workstationProfile,
    envFile,
    probe: inprocProbe
      ? {
          ok: inprocProbe.ok,
          python: inprocProbe.python,
          providers: inprocProbe.providers,
          error: inprocProbe.error,
        }
      : null,
    stages,
    blockers: stages.flatMap((stage) =>
      stage.issues.map((message) => `${stage.label}: ${message}`),
    ),
    warnings: stages.flatMap((stage) =>
      stage.warnings.map((message) => `${stage.label}: ${message}`),
    ),
  };
}

function buildInprocProcessorReadiness(kind) {
  const prefix = kind === "video" ? "SHAPE_VIDEO" : "SHAPE_AUDIO";
  const label = kind === "video" ? "Procesador video" : "Procesador audio";
  const expectedPath = kind === "video" ? "/process-frame" : "/process-audio";
  const issues = [];
  const warnings = [];
  const command = env[`${prefix}_PROCESSOR_COMMAND`];
  const endpoint = env[`${prefix}_PROCESSOR_ENDPOINT`];
  const healthUrl = env[`${prefix}_PROCESSOR_HEALTH_URL`];

  if (!endpoint || !validHttpUrl(endpoint)) {
    issues.push(
      `${prefix}_PROCESSOR_ENDPOINT no configurado o inválido (modo inproc colapsa a ${expectedPath} del :9100).`,
    );
  }
  if (command) {
    warnings.push(
      `${prefix}_PROCESSOR_COMMAND configurado; el modo inproc no lo usa (saltos colapsados).`,
    );
  }
  if (!healthUrl || !validHttpUrl(healthUrl)) {
    warnings.push(`${prefix}_PROCESSOR_HEALTH_URL no configurado o inválido.`);
  }

  return readinessStage(
    kind === "video" ? "video-processor" : "audio-processor",
    label,
    issues,
    warnings,
    { allowPassthrough: false },
  );
}

function probeModuleIssues(modules, issues) {
  if (!inprocProbe) return;
  if (inprocProbe.error) {
    issues.push(
      `Dependencias in-process no verificables (${inprocProbe.python}): ${inprocProbe.error || "probe falló"}.`,
    );
    return;
  }
  const missing = modules.filter((mod) => inprocProbe.modules[mod] !== true);
  if (missing.length > 0) {
    issues.push(
      `Faltan imports in-process: ${missing.join(", ")} (venv del endpoint sin requirements-inproc).`,
    );
  }
}

function buildInprocFaceReadiness() {
  const issues = [];
  const warnings = [];

  const inswapper = pathValue("SHAPE_INSWAPPER_MODEL");
  if (!inswapper || !existsSync(inswapper) || statSync(inswapper).size <= 0) {
    issues.push(
      `SHAPE_INSWAPPER_MODEL no existe o está vacío: ${inswapper ?? "sin configurar"}.`,
    );
  }
  probeModuleIssues(["numpy", "cv2", "onnxruntime", "insightface"], issues);

  const insightfaceHome = insightfaceHomePath();
  if (!existsSync(join(insightfaceHome, "models", "buffalo_l"))) {
    warnings.push(
      `buffalo_l pendiente de descarga en ${insightfaceHome} (auto-descarga en primer arranque).`,
    );
  }
  if (
    workstationProfile === "windows-nvidia" &&
    inprocProbe?.modules?.onnxruntime === true &&
    !inprocProbe.providers.includes("CUDAExecutionProvider")
  ) {
    warnings.push(
      "onnxruntime sin CUDAExecutionProvider (perfil windows-nvidia).",
    );
  }

  return readinessStage("face", "Face swap", issues, warnings, {
    allowPassthrough: false,
  });
}

function buildInprocBackgroundReadiness() {
  const issues = [];
  const warnings = [];
  const backgroundEngine = backgroundEngineInproc();

  if (backgroundEngine === "bmv2") {
    const checkpoint = pathValue("BMV2_MODEL_CHECKPOINT");
    if (
      !checkpoint ||
      !existsSync(checkpoint) ||
      statSync(checkpoint).size <= 0
    ) {
      issues.push(
        `BMV2_MODEL_CHECKPOINT no existe o está vacío: ${checkpoint ?? "sin configurar"} (SHAPE_BACKGROUND_ENGINE=bmv2).`,
      );
    }
  } else {
    const rvm = pathValue("SHAPE_RVM_MODEL");
    if (!rvm || !existsSync(rvm) || statSync(rvm).size <= 0) {
      issues.push(
        `SHAPE_RVM_MODEL no existe o está vacío: ${rvm ?? "sin configurar"}.`,
      );
    }
  }
  probeModuleIssues(["numpy", "cv2", "torch"], issues);

  return readinessStage("background", "Background matting", issues, warnings, {
    allowPassthrough: false,
  });
}

function buildInprocVoiceReadiness() {
  const issues = [];
  const warnings = [];

  if (managedVoiceEnabled()) {
    // Managed runtime: the endpoint server supervises VCClient; validate the
    // dist (binary present + executable) instead of a live external endpoint.
    const distDir = env.VCCLIENT000_DIST_DIR?.trim();
    if (!distDir) {
      issues.push(
        "VCCLIENT000_MANAGED=1 pero VCCLIENT000_DIST_DIR no está configurado (dir con el binario main de VCClient).",
      );
    } else {
      const binaryName = platform() === "win32" ? "main.exe" : "main";
      const binaryPath = join(resolvePath(distDir), binaryName);
      if (!existsSync(binaryPath)) {
        issues.push(
          `binario VCClient no encontrado: ${binaryPath} (VCCLIENT000_MANAGED requiere el dist real).`,
        );
      } else if (platform() !== "win32") {
        try {
          accessSync(binaryPath, fsConstants.X_OK);
        } catch {
          issues.push(`binario VCClient no ejecutable: ${binaryPath}.`);
        }
      }
    }
    return readinessStage("voice", "Cambio de voz", issues, warnings, {
      allowPassthrough: false,
    });
  }

  const endpoint = inprocVoiceEndpoint();
  if (!endpoint) {
    issues.push(
      "VCCLIENT000_HTTP_ENDPOINT no configurado (cliente persistente VCClient/w-okada; v2 convert_chunk o v1 /test).",
    );
  } else if (!validHttpUrl(endpoint)) {
    issues.push(`VCCLIENT000_HTTP_ENDPOINT inválido: ${endpoint}.`);
  }

  return readinessStage("voice", "Cambio de voz", issues, warnings, {
    allowPassthrough: false,
  });
}

function buildProcessorReadiness(kind) {
  const prefix = kind === "video" ? "SHAPE_VIDEO" : "SHAPE_AUDIO";
  const label = kind === "video" ? "Procesador video" : "Procesador audio";
  const issues = [];
  const warnings = [];
  const command = env[`${prefix}_PROCESSOR_COMMAND`];
  const endpoint = env[`${prefix}_PROCESSOR_ENDPOINT`];
  const healthUrl = env[`${prefix}_PROCESSOR_HEALTH_URL`];

  if (!command) {
    issues.push(`${prefix}_PROCESSOR_COMMAND no configurado.`);
  } else {
    pushExecutableIssue(issues, command, `${prefix}_PROCESSOR_COMMAND`);
  }
  if (!endpoint || !validHttpUrl(endpoint)) {
    issues.push(`${prefix}_PROCESSOR_ENDPOINT no configurado o inválido.`);
  }
  if (!healthUrl || !validHttpUrl(healthUrl)) {
    warnings.push(`${prefix}_PROCESSOR_HEALTH_URL no configurado o inválido.`);
  }

  return readinessStage(
    kind === "video" ? "video-processor" : "audio-processor",
    label,
    issues,
    warnings,
    { allowPassthrough: false },
  );
}

function buildFaceReadiness() {
  const issues = [];
  const warnings = [];
  const command = env.SHAPE_VIDEO_FRAME_COMMAND ?? env.SHAPE_FACE_COMMAND;
  const endpoint = env.SHAPE_VIDEO_FRAME_ENDPOINT ?? env.SHAPE_FACE_ENDPOINT;

  if (!command) {
    if (endpoint) {
      if (!validHttpUrl(endpoint)) {
        issues.push(`Endpoint de face swap inválido: ${endpoint}.`);
      }
      return readinessStage("face", "Face swap", issues, warnings);
    }

    issues.push(
      "Falta SHAPE_FACE_COMMAND, SHAPE_VIDEO_FRAME_COMMAND, SHAPE_FACE_ENDPOINT o SHAPE_VIDEO_FRAME_ENDPOINT.",
    );
    return readinessStage("face", "Face swap", issues, warnings);
  }

  requireCommandPlaceholder(command, "input", "comando de face swap", issues);
  requireCommandPlaceholder(command, "output", "comando de face swap", issues);
  requireCommandPlaceholder(
    command,
    "identity",
    "comando de face swap",
    issues,
  );
  pushExecutableIssue(issues, command, "comando de face swap");

  if (command.includes("facefusion_frame.py")) {
    appendFaceFusionReadiness(issues, warnings);
  }

  return readinessStage("face", "Face swap", issues, warnings);
}

function buildBackgroundReadiness() {
  const issues = [];
  const warnings = [];
  const command = env.SHAPE_VIDEO_FRAME_COMMAND ?? env.SHAPE_BACKGROUND_COMMAND;
  const endpoint =
    env.SHAPE_VIDEO_FRAME_ENDPOINT ?? env.SHAPE_BACKGROUND_ENDPOINT;

  if (!command) {
    if (endpoint) {
      if (!validHttpUrl(endpoint)) {
        issues.push(`Endpoint de background inválido: ${endpoint}.`);
      }
      return readinessStage(
        "background",
        "Background matting",
        issues,
        warnings,
      );
    }

    issues.push(
      "Falta SHAPE_BACKGROUND_COMMAND, SHAPE_VIDEO_FRAME_COMMAND, SHAPE_BACKGROUND_ENDPOINT o SHAPE_VIDEO_FRAME_ENDPOINT.",
    );
    return readinessStage("background", "Background matting", issues, warnings);
  }

  requireCommandPlaceholder(command, "input", "comando de background", issues);
  requireCommandPlaceholder(command, "output", "comando de background", issues);
  requireCommandPlaceholder(
    command,
    "clean_plate",
    "comando de background",
    issues,
  );
  pushExecutableIssue(issues, command, "comando de background");

  if (command.includes("backgroundmattingv2_frame.py")) {
    appendBackgroundReadiness(issues, warnings);
  }

  return readinessStage("background", "Background matting", issues, warnings);
}

function buildVoiceReadiness() {
  const issues = [];
  const warnings = [];
  const command = env.SHAPE_AUDIO_CHUNK_COMMAND ?? env.SHAPE_VOICE_COMMAND;
  const endpoint = env.SHAPE_AUDIO_CHUNK_ENDPOINT ?? env.SHAPE_VOICE_ENDPOINT;

  if (!command) {
    if (endpoint) {
      if (!validHttpUrl(endpoint)) {
        issues.push(`Endpoint de voz inválido: ${endpoint}.`);
      }
      return readinessStage("voice", "Cambio de voz", issues, warnings);
    }

    issues.push(
      "Falta SHAPE_VOICE_COMMAND, SHAPE_AUDIO_CHUNK_COMMAND, SHAPE_VOICE_ENDPOINT o SHAPE_AUDIO_CHUNK_ENDPOINT.",
    );
    return readinessStage("voice", "Cambio de voz", issues, warnings);
  }

  requireCommandPlaceholder(command, "input", "comando de voz", issues);
  requireCommandPlaceholder(command, "output", "comando de voz", issues);
  requireCommandPlaceholder(command, "sample_rate", "comando de voz", issues);
  pushExecutableIssue(issues, command, "comando de voz");

  if (command.includes("vcclient000_chunk.py")) {
    appendVcClientReadiness(issues, warnings);
  }

  return readinessStage("voice", "Cambio de voz", issues, warnings);
}

function appendFaceFusionReadiness(issues, warnings) {
  if (env.FACEFUSION_COMMAND_TEMPLATE) {
    requireCommandPlaceholder(
      env.FACEFUSION_COMMAND_TEMPLATE,
      "identity",
      "FACEFUSION_COMMAND_TEMPLATE",
      issues,
    );
    pushExecutableIssue(
      issues,
      env.FACEFUSION_COMMAND_TEMPLATE,
      "FACEFUSION_COMMAND_TEMPLATE",
    );
    return;
  }

  const facefusionDir = pathValue("FACEFUSION_DIR");
  const entrypoint = pathValue("FACEFUSION_ENTRYPOINT") ?? "facefusion.py";
  const resolvedEntrypoint =
    facefusionDir && !isAbsolutePath(entrypoint)
      ? join(facefusionDir, entrypoint)
      : entrypoint;

  if (!facefusionDir || !existsSync(facefusionDir)) {
    issues.push(
      `FACEFUSION_DIR no existe: ${facefusionDir ?? "sin configurar"}.`,
    );
  }
  if (!existsSync(resolvedEntrypoint)) {
    issues.push(`FaceFusion entrypoint no existe: ${resolvedEntrypoint}.`);
  }
  pushExecutableIssue(
    issues,
    env.FACEFUSION_PYTHON ?? defaultPython(),
    "FACEFUSION_PYTHON",
  );
  if (
    (env.FACEFUSION_EXECUTION_PROVIDERS ?? "cuda").includes("cuda") &&
    !nvidiaAvailable &&
    !skipHardware
  ) {
    warnings.push(
      "FACEFUSION_EXECUTION_PROVIDERS usa cuda sin nvidia-smi detectable.",
    );
  }
}

function appendBackgroundReadiness(issues, warnings) {
  if (env.BMV2_COMMAND_TEMPLATE) {
    requireCommandPlaceholder(
      env.BMV2_COMMAND_TEMPLATE,
      "clean_plate",
      "BMV2_COMMAND_TEMPLATE",
      issues,
    );
    pushExecutableIssue(
      issues,
      env.BMV2_COMMAND_TEMPLATE,
      "BMV2_COMMAND_TEMPLATE",
    );
    return;
  }

  const repoDir = pathValue("BMV2_REPO_DIR");
  const checkpoint = pathValue("BMV2_MODEL_CHECKPOINT");

  if (!repoDir || !existsSync(join(repoDir, "inference_images.py"))) {
    issues.push(
      `BMV2_REPO_DIR no contiene inference_images.py: ${repoDir ?? "sin configurar"}.`,
    );
  }
  if (
    !checkpoint ||
    !existsSync(checkpoint) ||
    statSync(checkpoint).size <= 0
  ) {
    issues.push(
      `BMV2_MODEL_CHECKPOINT no existe o está vacío: ${checkpoint ?? "sin configurar"}.`,
    );
  }
  pushExecutableIssue(
    issues,
    env.BMV2_PYTHON ?? defaultPython(),
    "BMV2_PYTHON",
  );
  if (
    (env.BMV2_DEVICE ?? "cuda") === "cuda" &&
    !nvidiaAvailable &&
    !skipHardware
  ) {
    warnings.push("BMV2_DEVICE=cuda sin nvidia-smi detectable.");
  }
}

function appendVcClientReadiness(issues, warnings) {
  const commandTemplate = env.VCCLIENT000_CHUNK_COMMAND;
  const endpoint = env.VCCLIENT000_HTTP_ENDPOINT;
  const httpMode = normalizeVcClientHttpMode(env.VCCLIENT000_HTTP_MODE);

  if (commandTemplate) {
    requireCommandPlaceholder(
      commandTemplate,
      "sample_rate",
      "VCCLIENT000_CHUNK_COMMAND",
      issues,
    );
    pushExecutableIssue(issues, commandTemplate, "VCCLIENT000_CHUNK_COMMAND");
    return;
  }

  if (!endpoint || !validHttpUrl(endpoint)) {
    issues.push("VCCLIENT000_HTTP_ENDPOINT no configurado o inválido.");
    return;
  }

  if (!["auto", "vcclient2", "w-okada-rest", "shape-json"].includes(httpMode)) {
    issues.push(`VCCLIENT000_HTTP_MODE no soportado: ${httpMode}.`);
  }

  let parsed = null;
  try {
    parsed = new URL(endpoint);
  } catch {
    parsed = null;
  }
  const path = parsed?.pathname.replace(/\/+$/, "") ?? "";
  if (httpMode === "w-okada-rest" && path && path !== "/test") {
    warnings.push("vcclient000 w-okada-rest normalmente debe apuntar a /test.");
  }
  if (
    httpMode === "vcclient2" &&
    path &&
    path !== "/api/voice-changer/convert_chunk"
  ) {
    warnings.push(
      "vcclient000 vcclient2 normalmente debe apuntar a /api/voice-changer/convert_chunk (o la URL base).",
    );
  }
}

function readinessStage(id, label, issues, warnings, options = {}) {
  const allowPassthrough = options.allowPassthrough ?? true;
  const status =
    allowPassthrough && wrapperPassthroughEnabled()
      ? issues.length > 0
        ? "passthrough"
        : "ready"
      : issues.length > 0
        ? "blocked"
        : warnings.length > 0
          ? "warning"
          : "ready";
  return {
    id,
    label,
    status,
    configured: issues.length === 0,
    issues: [...new Set(issues)],
    warnings: [...new Set(warnings)],
  };
}

function requireCommandPlaceholder(command, placeholder, label, target) {
  if (!command.includes(`{${placeholder}}`)) {
    target.push(`${label} debe incluir {${placeholder}}.`);
  }
}

function pushExecutableIssue(target, command, label) {
  const result = commandExecutableStatus(command);
  if (!result.ok) target.push(`${label} ${result.message}`);
}

function validHttpUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function normalizeWorkstationProfile(value) {
  const normalized = String(value || "manual")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (!normalized || normalized === "manual") return "manual";
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
  return "manual";
}

function defaultWorkstationProfile() {
  if (platform() === "darwin" && process.arch === "arm64") {
    return "apple-silicon";
  }
  if (hasNvidiaRuntime()) return "windows-nvidia";
  return "manual";
}

function hasNvidiaRuntime() {
  try {
    const result = spawnSync(
      "nvidia-smi",
      ["--query-gpu=name", "--format=csv,noheader"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 2000,
        windowsHide: true,
      },
    );
    return result.status === 0 && Boolean((result.stdout ?? "").trim());
  } catch {
    return false;
  }
}

function runtimeCommandForProfile(profile) {
  const detected = defaultWorkstationProfile();
  const selected =
    profile === "manual"
      ? detected === "manual"
        ? "windows-nvidia"
        : detected
      : profile;
  if (inprocMode) {
    return `pnpm models:bootstrap -- --profile ${selected} --engine inproc --write-runtime`;
  }
  return `pnpm models:runtime -- --profile ${selected} --preset local-wrappers`;
}

function argValue(name) {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);

  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}
