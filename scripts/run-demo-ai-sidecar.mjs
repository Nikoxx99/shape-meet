import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

const args = process.argv.slice(2);
const host = argValue("--host") ?? process.env.SHAPE_AI_HOST ?? "127.0.0.1";
const port = argValue("--port") ?? process.env.SHAPE_AI_PORT ?? "7851";
const processorHost =
  argValue("--processor-host") ??
  process.env.SHAPE_DEMO_PROCESSOR_HOST ??
  "127.0.0.1";
const videoPort =
  argValue("--video-port") ??
  process.env.SHAPE_DEMO_VIDEO_PROCESSOR_PORT ??
  "7860";
const audioPort =
  argValue("--audio-port") ??
  process.env.SHAPE_DEMO_AUDIO_PROCESSOR_PORT ??
  "7861";
const python = resolveSidecarPython();
const runtimeEnv = readRuntimeEnv(renderRuntimeEnv());
const sidecarEnv = {
  ...process.env,
  ...runtimeEnv,
  SHAPE_AI_PYTHON: python,
  SENTRY_DEBUG:
    process.env.SHAPE_DEMO_SENTRY_DEBUG ??
    process.env.SHAPE_AI_SENTRY_DEBUG ??
    "false",
  SHAPE_AI_ACCESS_LOG:
    process.env.SHAPE_DEMO_AI_ACCESS_LOG ??
    process.env.SHAPE_AI_ACCESS_LOG ??
    "false",
  SHAPE_SENTRY_CAPTURE_PROCESSOR_ERRORS:
    process.env.SHAPE_DEMO_SENTRY_CAPTURE_PROCESSOR_ERRORS ??
    process.env.SHAPE_SENTRY_CAPTURE_PROCESSOR_ERRORS ??
    "false",
};

const sidecar = spawn(
  python,
  ["apps/ai-sidecar/server.py", "--host", host, "--port", String(port)],
  {
    cwd: process.cwd(),
    env: sidecarEnv,
    stdio: "inherit",
  },
);

function stopSidecar(signal) {
  if (sidecar.exitCode === null) {
    sidecar.kill(signal);
  }
}

process.on("SIGINT", () => stopSidecar("SIGINT"));
process.on("SIGTERM", () => stopSidecar("SIGTERM"));

sidecar.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

function renderRuntimeEnv() {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/prepare-ai-runtime-demo.mjs",
      "--print",
      "--processor-host",
      processorHost,
      "--video-port",
      String(videoPort),
      "--audio-port",
      String(audioPort),
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, SHAPE_AI_PYTHON: python },
    },
  );

  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`No se pudo preparar runtime IA demo.\n${output}`);
  }

  return result.stdout;
}

function readRuntimeEnv(content) {
  const env = {};

  for (const rawLine of content.split(/\r?\n/)) {
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
    env[key] = value;
  }

  return env;
}

function resolveSidecarPython() {
  const systemPython =
    process.env.SHAPE_AI_PYTHON ||
    (process.platform === "win32" ? "python" : "python3");

  if (process.env.SHAPE_AI_PYTHON) return systemPython;
  if (devVenvDisabled() || !sentryDsnConfigured()) return systemPython;

  try {
    ensureDevVenv(systemPython);
    return devVenvPython();
  } catch (error) {
    console.warn(
      [
        "[shape-ai-sidecar] no se pudo preparar venv dev con sentry-sdk.",
        error instanceof Error ? error.message : String(error),
        `Usando ${systemPython}.`,
      ].join(" "),
    );
    return systemPython;
  }
}

function ensureDevVenv(systemPython) {
  const python = devVenvPython();

  if (!existsSync(python)) {
    mkdirSync(devVenvParentDir(), { recursive: true });
    runChecked(systemPython, ["-m", "venv", devVenvDir()], {
      label: "crear venv dev del sidecar IA",
    });
  }

  if (!pythonModuleAvailable(python, "sentry_sdk")) {
    runChecked(python, ["-m", "pip", "install", "-r", devRequirementsFile()], {
      label: "instalar dependencias dev del sidecar IA",
    });
  }

  if (!pythonModuleAvailable(python, "sentry_sdk")) {
    throw new Error("sentry-sdk no quedó disponible en el venv dev.");
  }
}

function devVenvDisabled() {
  const value = process.env.SHAPE_AI_DEV_VENV ?? "";
  return ["0", "false", "no", "off"].includes(value.toLowerCase());
}

function sentryDsnConfigured() {
  if ("SENTRY_DSN" in process.env && !process.env.SENTRY_DSN?.trim()) {
    return false;
  }

  return Boolean(
    process.env.SENTRY_DSN?.trim() ||
    process.env.VITE_SENTRY_DSN?.trim() ||
    process.env.NEXT_PUBLIC_SENTRY_DSN?.trim() ||
    envFileValue(".env.local", [
      "SENTRY_DSN",
      "VITE_SENTRY_DSN",
      "NEXT_PUBLIC_SENTRY_DSN",
    ]) ||
    envFileValue("apps/desktop/.env.local", [
      "SENTRY_DSN",
      "VITE_SENTRY_DSN",
    ]) ||
    envFileValue("apps/admin/.env.local", [
      "SENTRY_DSN",
      "NEXT_PUBLIC_SENTRY_DSN",
    ]),
  );
}

function envFileValue(path, keys) {
  const values = readEnvFile(join(repoRoot, path));
  for (const key of keys) {
    const value = values[key]?.trim();
    if (value) return value;
  }
  return null;
}

function readEnvFile(path) {
  if (!existsSync(path)) return {};
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

function pythonModuleAvailable(python, moduleName) {
  const result = spawnSync(
    python,
    ["-c", `import ${moduleName}; print("ok")`],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  return result.status === 0;
}

function runChecked(command, commandArgs, { label }) {
  console.log(`> ${label}`);
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`${label} falló con código ${result.status}.`);
  }
}

function devVenvParentDir() {
  return join(repoRoot, "output", "ai-sidecar-dev");
}

function devVenvDir() {
  return process.env.SHAPE_AI_DEV_VENV_DIR || join(devVenvParentDir(), "venv");
}

function devVenvPython() {
  return process.platform === "win32"
    ? join(devVenvDir(), "Scripts", "python.exe")
    : join(devVenvDir(), "bin", "python");
}

function devRequirementsFile() {
  return join(repoRoot, "apps", "ai-sidecar", "requirements-dev.txt");
}

function argValue(name) {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);

  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}
