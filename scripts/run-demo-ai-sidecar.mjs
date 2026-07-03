import { spawn, spawnSync } from "node:child_process";

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
const python =
  process.env.SHAPE_AI_PYTHON ||
  (process.platform === "win32" ? "python" : "python3");
const runtimeEnv = readRuntimeEnv(renderRuntimeEnv());

const sidecar = spawn(
  python,
  ["apps/ai-sidecar/server.py", "--host", host, "--port", String(port)],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...runtimeEnv,
    },
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
      env: process.env,
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

function argValue(name) {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);

  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}
