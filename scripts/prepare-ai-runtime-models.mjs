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
const processorHost =
  argValue("--processor-host") ??
  process.env.SHAPE_PROCESSOR_HOST ??
  "127.0.0.1";
const videoPort =
  argValue("--video-port") ?? process.env.SHAPE_VIDEO_PROCESSOR_PORT ?? "7860";
const audioPort =
  argValue("--audio-port") ?? process.env.SHAPE_AUDIO_PROCESSOR_PORT ?? "7861";
const outputPath =
  argValue("--out") ??
  process.env.SHAPE_AI_RUNTIME_ENV_FILE ??
  defaultRuntimeEnvPath();
const config = {
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
  faceCommand: argValue("--face-command") ?? process.env.SHAPE_FACE_COMMAND,
  backgroundCommand:
    argValue("--background-command") ?? process.env.SHAPE_BACKGROUND_COMMAND,
  audioChunkCommand:
    argValue("--audio-chunk-command") ?? process.env.SHAPE_AUDIO_CHUNK_COMMAND,
  voiceCommand: argValue("--voice-command") ?? process.env.SHAPE_VOICE_COMMAND,
  modelTimeout:
    argValue("--model-timeout") ??
    process.env.SHAPE_MODEL_COMMAND_TIMEOUT_SECS ??
    "8",
  processorTimeout:
    argValue("--processor-timeout") ??
    process.env.SHAPE_PROCESSOR_TIMEOUT_SECS ??
    "10",
};

if (!hasAnyModelCommand(config)) {
  fail(
    [
      "Define al menos un comando de modelo:",
      "--video-frame-command, --face-command, --background-command, --audio-chunk-command o --voice-command.",
      "Ejemplo:",
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
  return [
    "# Shape Meet model AI runtime",
    "# Runtime local para wrappers reales de face swap, fondo y voz.",
    "SHAPE_AI_MODE=adapter-contract",
    `SHAPE_FACE_ENGINE=${input.faceEngine}`,
    `SHAPE_BACKGROUND_ENGINE=${input.backgroundEngine}`,
    `SHAPE_VOICE_ENGINE=${input.voiceEngine}`,
    `SHAPE_PROCESSOR_TIMEOUT_SECS=${input.processorTimeout}`,
    `SHAPE_MODEL_COMMAND_TIMEOUT_SECS=${input.modelTimeout}`,
    `SHAPE_VIDEO_PROCESSOR_COMMAND=${input.processorCommand} --kind video --host ${processorHost} --port ${videoPort}`,
    `SHAPE_VIDEO_PROCESSOR_ENDPOINT=http://${processorHost}:${videoPort}/process-frame`,
    `SHAPE_VIDEO_PROCESSOR_HEALTH_URL=http://${processorHost}:${videoPort}/health`,
    ...optionalLine("SHAPE_VIDEO_FRAME_COMMAND", input.videoFrameCommand),
    ...optionalLine("SHAPE_FACE_COMMAND", input.faceCommand),
    ...optionalLine("SHAPE_BACKGROUND_COMMAND", input.backgroundCommand),
    `SHAPE_AUDIO_PROCESSOR_COMMAND=${input.processorCommand} --kind audio --host ${processorHost} --port ${audioPort}`,
    `SHAPE_AUDIO_PROCESSOR_ENDPOINT=http://${processorHost}:${audioPort}/process-audio`,
    `SHAPE_AUDIO_PROCESSOR_HEALTH_URL=http://${processorHost}:${audioPort}/health`,
    ...optionalLine("SHAPE_AUDIO_CHUNK_COMMAND", input.audioChunkCommand),
    ...optionalLine("SHAPE_VOICE_COMMAND", input.voiceCommand),
    "",
  ].join("\n");
}

function optionalLine(key, value) {
  return value ? [`${key}=${value}`] : [`# ${key}=`];
}

function hasAnyModelCommand(input) {
  return Boolean(
    input.videoFrameCommand ||
    input.faceCommand ||
    input.backgroundCommand ||
    input.audioChunkCommand ||
    input.voiceCommand,
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
