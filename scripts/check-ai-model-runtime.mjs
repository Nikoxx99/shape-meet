import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
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
  argValue("--profile") ?? env.SHAPE_MODEL_WORKSTATION_PROFILE ?? "manual",
);
const checks = [];
const warnings = [];
const issues = [];
const nextSteps = [];
let nvidiaAvailable = false;

main();

function main() {
  checkBaseFiles();
  checkRuntimeEnv();
  if (!skipHardware) checkHardware();
  checkProcessor("video");
  checkProcessor("audio");
  checkVideoModelCommands();
  checkVoiceModelCommands();
  printReport();

  if (issues.length > 0 || (strict && warnings.length > 0)) process.exit(1);
}

function checkBaseFiles() {
  const wrapperPaths = [
    "apps/ai-sidecar/server.py",
    "apps/ai-sidecar/processors/shape_processor_command.py",
    "apps/ai-sidecar/wrappers/facefusion_frame.py",
    "apps/ai-sidecar/wrappers/backgroundmattingv2_frame.py",
    "apps/ai-sidecar/wrappers/vcclient000_chunk.py",
  ];

  for (const path of wrapperPaths) {
    if (!existsSync(join(repoRoot, path))) issue(`Falta ${path}.`);
  }

  ok("contrato local de sidecar y wrappers presentes");

  if (!skipWrapperSmoke) {
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
    nvidiaAvailable = true;
    ok(`NVIDIA detectada: ${firstLine(nvidia.stdout)}`);
    return;
  }

  if (platform() === "darwin" && process.arch === "arm64") {
    warn(
      "Apple Silicon detectado: CUDA no está disponible; usa comandos/modelos compatibles con Metal/MPS para esta máquina.",
    );
    return;
  }

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
      "Configura FACEFUSION_DIR y FACEFUSION_PYTHON o usa `pnpm models:runtime -- --profile windows-nvidia --preset local-wrappers`.",
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
    "Arranca vcclient000/w-okada localmente y configura VCCLIENT000_HTTP_ENDPOINT=http://127.0.0.1:18888/test.",
  );
}

function normalizeVcClientHttpMode(value) {
  const mode = (value || "auto").trim().toLowerCase().replace(/_/g, "-");
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
  const looksLikeWOkada = path === "" || path === "/test";
  if (httpMode === "w-okada-rest" && !looksLikeWOkada) {
    warn(
      "VCCLIENT000_HTTP_MODE=w-okada-rest usa el REST oficial de VCClient; normalmente el endpoint es http://127.0.0.1:18888/test o la URL base.",
    );
  }

  if (httpMode === "auto" && !looksLikeWOkada) {
    warn(
      "VCCLIENT000_HTTP_ENDPOINT no termina en /test y VCCLIENT000_HTTP_MODE está en auto; se tratará como endpoint Shape JSON. Para VCClient oficial usa VCCLIENT000_HTTP_MODE=w-okada-rest.",
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
  const realModelReadiness = buildRealModelReadiness();

  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: issues.length === 0 && (!strict || warnings.length === 0),
          envFile,
          profile: workstationProfile,
          realModelReadiness,
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

function buildRealModelReadiness() {
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

  if (!["auto", "w-okada-rest", "shape-json"].includes(httpMode)) {
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

function runtimeCommandForProfile(profile) {
  const selected = profile === "manual" ? "windows-nvidia" : profile;
  return `pnpm models:runtime -- --profile ${selected} --preset local-wrappers`;
}

function argValue(name) {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);

  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}
