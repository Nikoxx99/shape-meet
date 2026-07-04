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
  for (const path of [
    "apps/ai-sidecar/server.py",
    "apps/ai-sidecar/processors/shape_processor_command.py",
    "apps/ai-sidecar/wrappers/facefusion_frame.py",
    "apps/ai-sidecar/wrappers/backgroundmattingv2_frame.py",
    "apps/ai-sidecar/wrappers/vcclient000_chunk.py",
  ]) {
    if (!existsSync(join(repoRoot, path))) issue(`Falta ${path}.`);
  }

  ok("contrato local de sidecar y wrappers presentes");
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
  const face = env.SHAPE_FACE_COMMAND;
  const background = env.SHAPE_BACKGROUND_COMMAND;

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

  checkFaceCommand(face);
  checkBackgroundCommand(background);
}

function checkFaceCommand(command) {
  if (!command) {
    warn("SHAPE_FACE_COMMAND no configurado.");
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

function checkBackgroundCommand(command) {
  if (!command) {
    warn("SHAPE_BACKGROUND_COMMAND no configurado.");
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
  const voice = env.SHAPE_VOICE_COMMAND;

  if (combined) {
    checkModelCommand(combined, "SHAPE_AUDIO_CHUNK_COMMAND", [
      "input",
      "output",
      "sample_rate",
    ]);
    ok("wrapper combinado de audio configurado");
    return;
  }

  if (!voice) {
    warn("SHAPE_VOICE_COMMAND no configurado.");
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
  const executable = commandExecutable(command);
  if (!executable) {
    issue(`${label} no tiene ejecutable detectable.`);
    return;
  }

  if (isPathLike(executable)) {
    const resolved = resolvePath(executable);
    if (!existsSync(resolved)) {
      issue(`${label} ejecutable no existe: ${resolved}`);
      return;
    }
    ok(`${label} ejecutable disponible: ${resolved}`);
    return;
  }

  const result = spawnSync(executable, ["--version"], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: process.platform === "win32" && /\.cmd$/i.test(executable),
  });
  if (result.status !== 0 && !which(executable)) {
    issue(`${label} ejecutable no disponible en PATH: ${executable}`);
    return;
  }

  ok(`${label} ejecutable disponible: ${executable}`);
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
  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: issues.length === 0 && (!strict || warnings.length === 0),
          envFile,
          profile: workstationProfile,
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
  for (const check of checks) console.log(`ok: ${check}`);
  for (const warning of warnings) console.warn(`warn: ${warning}`);
  for (const currentIssue of issues) console.error(`error: ${currentIssue}`);
  for (const step of nextSteps) console.log(`next: ${step}`);

  if (issues.length === 0 && (!strict || warnings.length === 0)) {
    console.log("AI model doctor ok");
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
