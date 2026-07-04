import { spawn } from "node:child_process";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const args = process.argv.slice(2);
const daemon = args.includes("--daemon");
const passthrough = args.includes("--passthrough");
const demoEffects = args.includes("--demo-effects");
const host =
  argValue("--host") ?? process.env.SHAPE_MODEL_ENDPOINT_HOST ?? "127.0.0.1";
const port =
  argValue("--port") ?? process.env.SHAPE_MODEL_ENDPOINT_PORT ?? "9100";
const python =
  argValue("--python") ??
  process.env.SHAPE_MODEL_ENDPOINT_PYTHON ??
  process.env.SHAPE_AI_PYTHON ??
  (process.platform === "win32" ? "python" : "python3");
const pidFile =
  argValue("--pid-file") ??
  process.env.SHAPE_MODEL_ENDPOINT_PID_FILE ??
  join(repoRoot, "output", "model-endpoint.pid");
const logFile =
  argValue("--log-file") ??
  process.env.SHAPE_MODEL_ENDPOINT_LOG_FILE ??
  join(repoRoot, "output", "model-endpoint.log");

if (daemon) startDaemon();

const serverArgs = [
  "apps/ai-sidecar/processors/shape_model_endpoint_server.py",
  "--host",
  host,
  "--port",
  String(port),
];
if (passthrough) serverArgs.push("--passthrough");
if (demoEffects) serverArgs.push("--demo-effects");

const child = spawn(python, serverArgs, {
  cwd: repoRoot,
  env: {
    ...process.env,
    SHAPE_MODEL_ENDPOINT_HOST: host,
    SHAPE_MODEL_ENDPOINT_PORT: String(port),
  },
  stdio: "inherit",
});

function stop(signal) {
  if (child.exitCode === null) child.kill(signal);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

function startDaemon() {
  mkdirSync(dirname(pidFile), { recursive: true });
  mkdirSync(dirname(logFile), { recursive: true });
  const logFd = openSync(logFile, "a");
  const childArgs = [
    fileURLToPath(import.meta.url),
    ...args.filter((arg) => arg !== "--daemon"),
  ];
  const child = spawn(process.execPath, childArgs, {
    cwd: repoRoot,
    env: {
      ...process.env,
      SHAPE_MODEL_ENDPOINT_DAEMON: "1",
    },
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
  });

  child.unref();
  writeFileSync(pidFile, `${child.pid}\n`);
  console.log(`[shape-model-endpoint] daemon iniciado pid=${child.pid}`);
  console.log(`[shape-model-endpoint] pid=${pidFile}`);
  console.log(`[shape-model-endpoint] log=${logFile}`);
  process.exit(0);
}

function argValue(name) {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);

  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}
