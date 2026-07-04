import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const printOnly = args.includes("--print");
const preferBundled = args.includes("--prefer-bundled");
const workstationProfile = normalizeWorkstationProfile(
  argValue("--profile") ??
    process.env.SHAPE_MODEL_WORKSTATION_PROFILE ??
    defaultWorkstationProfile(),
);
const workstationDefaults = workstationProfileDefaults(workstationProfile);
const processorHost =
  argValue("--processor-host") ??
  process.env.SHAPE_PROCESSOR_HOST ??
  "127.0.0.1";
const videoPort =
  argValue("--video-port") ?? process.env.SHAPE_VIDEO_PROCESSOR_PORT ?? "7860";
const audioPort =
  argValue("--audio-port") ?? process.env.SHAPE_AUDIO_PROCESSOR_PORT ?? "7861";
const modelEndpointHost =
  argValue("--model-endpoint-host") ??
  process.env.SHAPE_MODEL_ENDPOINT_HOST ??
  "127.0.0.1";
const modelEndpointPort =
  argValue("--model-endpoint-port") ??
  process.env.SHAPE_MODEL_ENDPOINT_PORT ??
  "9100";
const modelEndpointBaseUrl = `http://${modelEndpointHost}:${modelEndpointPort}`;
const outputPath =
  argValue("--out") ??
  process.env.SHAPE_AI_RUNTIME_ENV_FILE ??
  defaultRuntimeEnvPath();
const preset = (
  argValue("--preset") ??
  process.env.SHAPE_MODEL_RUNTIME_PRESET ??
  ""
).toLowerCase();
const passthrough = args.includes("--passthrough");
const engineMode = (
  argValue("--engine") ??
  process.env.SHAPE_MODEL_ENDPOINT_ENGINE ??
  ""
).toLowerCase();
const config = {
  runtimePreset: preset || "local-wrappers",
  engine: engineMode,
  modelEndpointHost,
  modelEndpointPort,
  processorCommand: resolveProcessorCommand(),
  faceEngine:
    argValue("--face-engine") ?? process.env.SHAPE_FACE_ENGINE ?? "facefusion",
  backgroundEngine:
    argValue("--background-engine") ??
    process.env.SHAPE_BACKGROUND_ENGINE ??
    "backgroundmattingv2",
  voiceEngine:
    argValue("--voice-engine") ??
    process.env.SHAPE_VOICE_ENGINE ??
    "vcclient000",
  videoFrameCommand:
    argValue("--video-frame-command") ?? process.env.SHAPE_VIDEO_FRAME_COMMAND,
  videoFrameEndpoint:
    argValue("--video-frame-endpoint") ??
    process.env.SHAPE_VIDEO_FRAME_ENDPOINT,
  faceCommand: argValue("--face-command") ?? process.env.SHAPE_FACE_COMMAND,
  faceEndpoint: argValue("--face-endpoint") ?? process.env.SHAPE_FACE_ENDPOINT,
  backgroundCommand:
    argValue("--background-command") ?? process.env.SHAPE_BACKGROUND_COMMAND,
  backgroundEndpoint:
    argValue("--background-endpoint") ?? process.env.SHAPE_BACKGROUND_ENDPOINT,
  audioChunkCommand:
    argValue("--audio-chunk-command") ?? process.env.SHAPE_AUDIO_CHUNK_COMMAND,
  audioChunkEndpoint:
    argValue("--audio-chunk-endpoint") ??
    process.env.SHAPE_AUDIO_CHUNK_ENDPOINT,
  voiceCommand: argValue("--voice-command") ?? process.env.SHAPE_VOICE_COMMAND,
  voiceEndpoint:
    argValue("--voice-endpoint") ?? process.env.SHAPE_VOICE_ENDPOINT,
  modelTimeout:
    argValue("--model-timeout") ??
    process.env.SHAPE_MODEL_COMMAND_TIMEOUT_SECS ??
    workstationDefaults.modelTimeout ??
    "8",
  processorTimeout:
    argValue("--processor-timeout") ??
    process.env.SHAPE_PROCESSOR_TIMEOUT_SECS ??
    workstationDefaults.processorTimeout ??
    "10",
  inswapperModel:
    argValue("--inswapper-model") ?? process.env.SHAPE_INSWAPPER_MODEL,
  rvmModel: argValue("--rvm-model") ?? process.env.SHAPE_RVM_MODEL,
  insightfaceHome:
    argValue("--insightface-home") ??
    process.env.SHAPE_INSIGHTFACE_HOME ??
    process.env.INSIGHTFACE_HOME,
  faceProviders:
    argValue("--face-providers") ?? process.env.SHAPE_FACE_EXECUTION_PROVIDERS,
  backgroundColor:
    argValue("--background-color") ?? process.env.SHAPE_BACKGROUND_COLOR,
  workstationProfile,
  modelEnv: resolveModelEnv(),
};

applyPreset(config);

if (!hasAnyModelAdapter(config)) {
  fail(
    [
      "Define al menos un comando o endpoint de modelo:",
      "--preset local-wrappers, --video-frame-command, --video-frame-endpoint, --face-command, --face-endpoint, --background-command, --background-endpoint, --audio-chunk-command, --audio-chunk-endpoint, --voice-command o --voice-endpoint.",
      "Ejemplo:",
      "pnpm models:runtime -- --preset local-wrappers --passthrough",
      "pnpm models:runtime -- --face-endpoint http://127.0.0.1:9101/face --background-endpoint http://127.0.0.1:9102/background --voice-endpoint http://127.0.0.1:9103/voice",
      "pnpm models:runtime -- --face-command 'python wrappers/facefusion_frame.py --input {input} --output {output} --identity {identity}' --background-command 'python wrappers/bmv2_frame.py --input {input} --output {output} --clean-plate {clean_plate}'",
    ].join("\n"),
  );
}

const content = renderRuntimeEnv(config);

if (printOnly || dryRun) {
  console.log(content);
}

if (!dryRun && !printOnly) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, content);
  console.log(`AI runtime modelos listo: ${outputPath}`);
  console.log(
    "Reinicia el sidecar desde la app para cargar esta configuración.",
  );
}

function renderRuntimeEnv(input) {
  if (
    input.engine === "inproc" &&
    ["local-endpoints", "endpoints"].includes(input.runtimePreset)
  ) {
    return renderInprocRuntimeEnv(input);
  }

  return [
    "# Shape Meet model AI runtime",
    "# Runtime local para wrappers reales de face swap, fondo y voz.",
    "SHAPE_AI_MODE=adapter-contract",
    `SHAPE_FACE_ENGINE=${input.faceEngine}`,
    `SHAPE_BACKGROUND_ENGINE=${input.backgroundEngine}`,
    `SHAPE_VOICE_ENGINE=${input.voiceEngine}`,
    `SHAPE_MODEL_WORKSTATION_PROFILE=${input.workstationProfile}`,
    `SHAPE_MODEL_RUNTIME_PRESET=${input.runtimePreset}`,
    `SHAPE_PROCESSOR_TIMEOUT_SECS=${input.processorTimeout}`,
    `SHAPE_MODEL_COMMAND_TIMEOUT_SECS=${input.modelTimeout}`,
    `SHAPE_VIDEO_PROCESSOR_COMMAND=${input.processorCommand} --kind video --host ${processorHost} --port ${videoPort}`,
    `SHAPE_VIDEO_PROCESSOR_ENDPOINT=http://${processorHost}:${videoPort}/process-frame`,
    `SHAPE_VIDEO_PROCESSOR_HEALTH_URL=http://${processorHost}:${videoPort}/health`,
    ...optionalLine("SHAPE_VIDEO_FRAME_COMMAND", input.videoFrameCommand),
    ...optionalLine("SHAPE_VIDEO_FRAME_ENDPOINT", input.videoFrameEndpoint),
    ...optionalLine("SHAPE_FACE_COMMAND", input.faceCommand),
    ...optionalLine("SHAPE_FACE_ENDPOINT", input.faceEndpoint),
    ...optionalLine("SHAPE_BACKGROUND_COMMAND", input.backgroundCommand),
    ...optionalLine("SHAPE_BACKGROUND_ENDPOINT", input.backgroundEndpoint),
    ...endpointRuntimeLines(input),
    `SHAPE_AUDIO_PROCESSOR_COMMAND=${input.processorCommand} --kind audio --host ${processorHost} --port ${audioPort}`,
    `SHAPE_AUDIO_PROCESSOR_ENDPOINT=http://${processorHost}:${audioPort}/process-audio`,
    `SHAPE_AUDIO_PROCESSOR_HEALTH_URL=http://${processorHost}:${audioPort}/health`,
    ...optionalLine("SHAPE_AUDIO_CHUNK_COMMAND", input.audioChunkCommand),
    ...optionalLine("SHAPE_AUDIO_CHUNK_ENDPOINT", input.audioChunkEndpoint),
    ...optionalLine("SHAPE_VOICE_COMMAND", input.voiceCommand),
    ...optionalLine("SHAPE_VOICE_ENDPOINT", input.voiceEndpoint),
    ...Object.entries(input.modelEnv).map(([key, value]) => `${key}=${value}`),
    "",
  ].join("\n");
}

function renderInprocRuntimeEnv(input) {
  // Collapsed hops (§2): server.py posts directly to the model endpoint
  // (:9100/process-frame|/process-audio); NO *_PROCESSOR_COMMAND so no
  // shape_processor_command process is spawned.
  const base = `http://${input.modelEndpointHost}:${input.modelEndpointPort}`;
  const timeouts = inprocPhaseTimeouts(input.workstationProfile);
  const faceProviders =
    input.faceProviders ?? defaultFaceProviders(input.workstationProfile);
  const backgroundEngine = ["rvm", "bmv2"].includes(input.backgroundEngine)
    ? input.backgroundEngine
    : "rvm";

  return [
    "# Shape Meet in-process AI runtime (collapsed hops, engines in :9100)",
    "# server.py posts directly to the model endpoint; no command processor.",
    "SHAPE_AI_MODE=adapter-contract",
    "SHAPE_FACE_ENGINE=insightface",
    `SHAPE_BACKGROUND_ENGINE=${backgroundEngine}`,
    "SHAPE_VOICE_ENGINE=vcclient000",
    `SHAPE_MODEL_WORKSTATION_PROFILE=${input.workstationProfile}`,
    `SHAPE_MODEL_RUNTIME_PRESET=${input.runtimePreset}`,
    "SHAPE_MODEL_ENDPOINT_ENGINE=inproc",
    `SHAPE_MODEL_ENDPOINT_HOST=${input.modelEndpointHost}`,
    `SHAPE_MODEL_ENDPOINT_PORT=${input.modelEndpointPort}`,
    `SHAPE_VIDEO_PROCESSOR_ENDPOINT=${base}/process-frame`,
    `SHAPE_VIDEO_PROCESSOR_HEALTH_URL=${base}/health`,
    `SHAPE_AUDIO_PROCESSOR_ENDPOINT=${base}/process-audio`,
    `SHAPE_AUDIO_PROCESSOR_HEALTH_URL=${base}/health`,
    "# SHAPE_VIDEO_PROCESSOR_COMMAND intentionally unset (collapsed hops)",
    "# SHAPE_AUDIO_PROCESSOR_COMMAND intentionally unset (collapsed hops)",
    "# Phase 1/2 timeouts (§4) — inner (endpoint) < outer (server->endpoint)",
    `SHAPE_PROCESSOR_TIMEOUT_SECS=${timeouts.processor}`,
    `SHAPE_AUDIO_PROCESSOR_TIMEOUT_SECS=${timeouts.audioProcessor}`,
    `SHAPE_MODEL_ENDPOINT_TIMEOUT_SECS=${timeouts.endpoint}`,
    `SHAPE_VOICE_ENDPOINT_TIMEOUT_SECS=${timeouts.voiceEndpoint}`,
    `SHAPE_MODEL_ENDPOINT_LOAD_TIMEOUT_SECS=${timeouts.load}`,
    `SHAPE_MODEL_ENDPOINT_POLL_TIMEOUT_SECS=${timeouts.poll}`,
    `SHAPE_MANAGED_HEALTH_TIMEOUT_SECS=${timeouts.managedHealth}`,
    "# In-process engine weights & providers (host-provided; never committed)",
    `SHAPE_FACE_EXECUTION_PROVIDERS=${faceProviders}`,
    ...optionalLine("SHAPE_INSWAPPER_MODEL", input.inswapperModel),
    ...optionalLine("SHAPE_RVM_MODEL", input.rvmModel),
    ...optionalLine("INSIGHTFACE_HOME", input.insightfaceHome),
    ...optionalLine("SHAPE_BACKGROUND_COLOR", input.backgroundColor),
    "",
  ].join("\n");
}

function inprocPhaseTimeouts(profile) {
  if (profile === "windows-nvidia") {
    // Phase 2 (RTX): tighter budgets.
    return {
      processor: "2.0",
      audioProcessor: "1.2",
      endpoint: "1.5",
      voiceEndpoint: "1.0",
      load: "30",
      poll: "0.75",
      managedHealth: "0.5",
    };
  }
  // Phase 1 (Mac CPU/MPS/CoreML): generous budgets, correctness over fps.
  return {
    processor: "4.0",
    audioProcessor: "2.5",
    endpoint: "3.0",
    voiceEndpoint: "2.0",
    load: "60",
    poll: "1.5",
    managedHealth: "1.0",
  };
}

function defaultFaceProviders(profile) {
  if (profile === "windows-nvidia") return "cuda";
  if (profile === "apple-silicon") return "coreml,cpu";
  return "cpu";
}

function endpointRuntimeLines(input) {
  if (!["local-endpoints", "endpoints"].includes(input.runtimePreset)) {
    return [];
  }

  return [
    `SHAPE_MODEL_ENDPOINT_HOST=${input.modelEndpointHost}`,
    `SHAPE_MODEL_ENDPOINT_PORT=${input.modelEndpointPort}`,
  ];
}

function optionalLine(key, value) {
  return value ? [`${key}=${value}`] : [`# ${key}=`];
}

function hasAnyModelAdapter(input) {
  return Boolean(
    input.videoFrameCommand ||
    input.videoFrameEndpoint ||
    input.faceCommand ||
    input.faceEndpoint ||
    input.backgroundCommand ||
    input.backgroundEndpoint ||
    input.audioChunkCommand ||
    input.audioChunkEndpoint ||
    input.voiceCommand ||
    input.voiceEndpoint,
  );
}

function applyPreset(input) {
  if (!preset) return;
  if (
    ![
      "local-wrappers",
      "repo-wrappers",
      "wrappers",
      "local-endpoints",
      "endpoints",
    ].includes(preset)
  ) {
    fail(`Preset de modelos no soportado: ${preset}`);
  }

  if (["local-endpoints", "endpoints"].includes(preset)) {
    input.videoFrameEndpoint ??= `${modelEndpointBaseUrl}/video-frame`;
    input.faceEndpoint ??= `${modelEndpointBaseUrl}/face`;
    input.backgroundEndpoint ??= `${modelEndpointBaseUrl}/background`;
    input.audioChunkEndpoint ??= `${modelEndpointBaseUrl}/voice`;
    input.voiceEndpoint ??= `${modelEndpointBaseUrl}/voice`;
    return;
  }

  input.faceCommand ??= `${pythonCommand()} ${shellQuote(wrapperPath("facefusion_frame.py"))} --input {input} --output {output} --identity {identity}`;
  input.backgroundCommand ??= `${pythonCommand()} ${shellQuote(wrapperPath("backgroundmattingv2_frame.py"))} --input {input} --output {output} --clean-plate {clean_plate}`;
  input.voiceCommand ??= `${pythonCommand()} ${shellQuote(wrapperPath("vcclient000_chunk.py"))} --input {input} --output {output} --sample-rate {sample_rate} --channels {channels} --format {format}`;
}

function resolveModelEnv() {
  const values = {};
  const mappedArgs = {
    FACEFUSION_DIR: "--facefusion-dir",
    FACEFUSION_ENTRYPOINT: "--facefusion-entrypoint",
    FACEFUSION_PYTHON: "--facefusion-python",
    FACEFUSION_PROCESSORS: "--facefusion-processors",
    FACEFUSION_EXECUTION_PROVIDERS: "--facefusion-providers",
    FACEFUSION_EXTRA_ARGS: "--facefusion-extra-args",
    FACEFUSION_COMMAND_TEMPLATE: "--facefusion-command-template",
    FACEFUSION_TIMEOUT_SECS: "--facefusion-timeout",
    BMV2_REPO_DIR: "--bmv2-repo-dir",
    BMV2_PYTHON: "--bmv2-python",
    BMV2_MODEL_CHECKPOINT: "--bmv2-checkpoint",
    BMV2_MODEL_TYPE: "--bmv2-model-type",
    BMV2_MODEL_BACKBONE: "--bmv2-backbone",
    BMV2_MODEL_BACKBONE_SCALE: "--bmv2-backbone-scale",
    BMV2_MODEL_REFINE_MODE: "--bmv2-refine-mode",
    BMV2_MODEL_REFINE_SAMPLE_PIXELS: "--bmv2-refine-sample-pixels",
    BMV2_DEVICE: "--bmv2-device",
    BMV2_EXTRA_ARGS: "--bmv2-extra-args",
    BMV2_COMMAND_TEMPLATE: "--bmv2-command-template",
    BMV2_TIMEOUT_SECS: "--bmv2-timeout",
    VCCLIENT000_CHUNK_COMMAND: "--vcclient000-command",
    VCCLIENT000_HTTP_ENDPOINT: "--vcclient000-http-endpoint",
    VCCLIENT000_HTTP_MODE: "--vcclient000-http-mode",
    VCCLIENT000_TIMEOUT_SECS: "--vcclient000-timeout",
  };

  for (const [key, argName] of Object.entries(mappedArgs)) {
    const value =
      argValue(argName) ??
      process.env[key] ??
      workstationDefaults.modelEnv[key];
    if (value) values[key] = value;
  }

  const passthroughValue =
    argValue("--wrapper-passthrough") ??
    process.env.SHAPE_WRAPPER_PASSTHROUGH ??
    defaultWrapperPassthrough();
  if (passthroughValue) {
    values.SHAPE_WRAPPER_PASSTHROUGH = passthroughValue;
  }
  if (values.VCCLIENT000_HTTP_ENDPOINT && !values.VCCLIENT000_HTTP_MODE) {
    values.VCCLIENT000_HTTP_MODE = "w-okada-rest";
  }

  return values;
}

function defaultWrapperPassthrough() {
  if (passthrough) return "true";
  if (["local-endpoints", "endpoints"].includes(preset)) return "false";
  return workstationDefaults.wrapperPassthrough;
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
  fail(
    `Perfil de workstation no soportado: ${value}. Usa manual, windows-nvidia o apple-silicon.`,
  );
}

function defaultWorkstationProfile() {
  if (process.platform === "darwin" && process.arch === "arm64") {
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

function workstationProfileDefaults(profile) {
  if (profile === "windows-nvidia") {
    return {
      modelTimeout: "30",
      processorTimeout: "75",
      wrapperPassthrough: "false",
      modelEnv: {
        FACEFUSION_DIR: "C:\\models\\FaceFusion",
        FACEFUSION_PYTHON: "C:\\models\\FaceFusion\\.venv\\Scripts\\python.exe",
        FACEFUSION_EXECUTION_PROVIDERS: "cuda",
        FACEFUSION_PROCESSORS: "face_swapper face_enhancer",
        FACEFUSION_EXTRA_ARGS: "--execution-thread-count 4",
        BMV2_REPO_DIR: "C:\\models\\BackgroundMattingV2",
        BMV2_PYTHON:
          "C:\\models\\BackgroundMattingV2\\.venv\\Scripts\\python.exe",
        BMV2_MODEL_CHECKPOINT:
          "C:\\models\\BackgroundMattingV2\\pytorch_resnet50.pth",
        BMV2_DEVICE: "cuda",
        BMV2_EXTRA_ARGS: "--model-refine-sample-pixels 80000",
        VCCLIENT000_HTTP_ENDPOINT: "http://127.0.0.1:18888/test",
        VCCLIENT000_HTTP_MODE: "w-okada-rest",
      },
    };
  }

  if (profile === "apple-silicon") {
    return {
      modelTimeout: "30",
      processorTimeout: "75",
      wrapperPassthrough: "true",
      modelEnv: {
        FACEFUSION_DIR: "~/models/FaceFusion",
        FACEFUSION_PYTHON: "~/models/FaceFusion/.venv/bin/python",
        FACEFUSION_EXECUTION_PROVIDERS: "cpu",
        FACEFUSION_PROCESSORS: "face_swapper face_enhancer",
        BMV2_REPO_DIR: "~/models/BackgroundMattingV2",
        BMV2_PYTHON: "~/models/BackgroundMattingV2/.venv/bin/python",
        BMV2_MODEL_CHECKPOINT:
          "~/models/BackgroundMattingV2/pytorch_resnet50.pth",
        BMV2_DEVICE: "mps",
        BMV2_EXTRA_ARGS: "--model-refine-sample-pixels 80000",
      },
    };
  }

  return { modelEnv: {} };
}

function wrapperPath(file) {
  return join(repoRoot, "apps", "ai-sidecar", "wrappers", file);
}

function pythonCommand() {
  return shellQuote(
    process.env.SHAPE_AI_PYTHON ||
      (process.platform === "win32" ? "python" : "python3"),
  );
}

function resolveProcessorCommand() {
  const explicit =
    argValue("--processor-command") ?? process.env.SHAPE_PROCESSOR_COMMAND;
  if (explicit) return explicit;

  const binary = findBundledProcessorBinary();
  const sourceCommand = sourceProcessorCommand();
  if (binary && (preferBundled || bundledProcessorIsFresh(binary))) {
    return shellQuote(binary);
  }

  return sourceCommand;
}

function findBundledProcessorBinary() {
  const binariesDir = join(
    repoRoot,
    "apps",
    "desktop",
    "src-tauri",
    "binaries",
  );
  if (!existsSync(binariesDir)) return null;

  const suffix = process.platform === "win32" ? ".exe" : "";
  const entries = readdirSync(binariesDir)
    .filter(
      (name) => name.startsWith("shape-ai-processor-") && name.endsWith(suffix),
    )
    .sort();
  const preferred =
    entries.find((name) => name.includes(currentPlatformHint())) ?? entries[0];
  return preferred ? join(binariesDir, preferred) : null;
}

function currentPlatformHint() {
  if (process.platform === "darwin") return "apple-darwin";
  if (process.platform === "win32") return "pc-windows-msvc";
  if (process.platform === "linux") return "unknown-linux";
  return process.platform;
}

function bundledProcessorIsFresh(binary) {
  try {
    return statSync(binary).mtimeMs >= statSync(processorSourcePath()).mtimeMs;
  } catch {
    return false;
  }
}

function sourceProcessorCommand() {
  const python =
    process.env.SHAPE_AI_PYTHON ||
    (process.platform === "win32" ? "python" : "python3");
  return `${shellQuote(python)} ${shellQuote(processorSourcePath())}`;
}

function processorSourcePath() {
  return join(
    repoRoot,
    "apps",
    "ai-sidecar",
    "processors",
    "shape_processor_command.py",
  );
}

function defaultRuntimeEnvPath() {
  if (process.platform === "win32") {
    const base =
      process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return join(base, "Shape Meet", "shape-ai-runtime.env");
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

  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "shape-meet", "shape-ai-runtime.env");
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;

  if (process.platform === "win32") {
    return `"${value.replace(/"/g, '\\"')}"`;
  }

  return `"${value.replace(/["\\$`]/g, "\\$&")}"`;
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
