import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const printOnly = args.includes("--print");
const outputPath =
  argValue("--out") ??
  process.env.SHAPE_AI_RUNTIME_ENV_FILE ??
  defaultRuntimeEnvPath();
const processorCommand = resolveProcessorCommand();
const content = renderRuntimeEnv(processorCommand);

if (printOnly || dryRun) {
  console.log(content);
}

if (!dryRun && !printOnly) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, content);
  console.log(`AI runtime demo listo: ${outputPath}`);
  console.log(
    "Reinicia el sidecar desde la app para cargar esta configuración.",
  );
}

function renderRuntimeEnv(command) {
  return [
    "# Shape Meet demo AI runtime",
    "# Procesadores locales para validar el pipeline sin modelos reales.",
    "SHAPE_AI_MODE=adapter-contract",
    "SHAPE_FACE_ENGINE=shape-demo-facefusion",
    "SHAPE_BACKGROUND_ENGINE=shape-demo-backgroundmattingv2",
    "SHAPE_VOICE_ENGINE=shape-demo-vcclient000",
    "SHAPE_PROCESSOR_DEMO_EFFECTS=true",
    "SHAPE_PROCESSOR_TIMEOUT_SECS=2",
    `SHAPE_VIDEO_PROCESSOR_COMMAND=${command} --kind video --host 127.0.0.1 --port 7860`,
    "SHAPE_VIDEO_PROCESSOR_ENDPOINT=http://127.0.0.1:7860/process-frame",
    "SHAPE_VIDEO_PROCESSOR_HEALTH_URL=http://127.0.0.1:7860/health",
    `SHAPE_AUDIO_PROCESSOR_COMMAND=${command} --kind audio --host 127.0.0.1 --port 7861`,
    "SHAPE_AUDIO_PROCESSOR_ENDPOINT=http://127.0.0.1:7861/process-audio",
    "SHAPE_AUDIO_PROCESSOR_HEALTH_URL=http://127.0.0.1:7861/health",
    "",
  ].join("\n");
}

function resolveProcessorCommand() {
  const explicit =
    argValue("--processor-command") ?? process.env.SHAPE_DEMO_PROCESSOR_COMMAND;
  if (explicit) return explicit;

  const binary = findBundledProcessorBinary();
  if (binary) return shellQuote(binary);

  const python =
    process.env.SHAPE_AI_PYTHON ||
    (process.platform === "win32" ? "python" : "python3");
  const script = join(
    repoRoot,
    "apps",
    "ai-sidecar",
    "processors",
    "shape_processor_command.py",
  );
  return `${shellQuote(python)} ${shellQuote(script)}`;
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
