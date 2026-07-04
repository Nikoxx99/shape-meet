import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

const tempDir = mkdtempSync(join(tmpdir(), "shape-ai-demo-daemon-"));
let sidecarPid = null;

try {
  const sidecarPort = await getFreePort();
  const videoPort = await getFreePort();
  const audioPort = await getFreePort();
  const pidFile = join(tempDir, "ai-demo.pid");
  const logFile = join(tempDir, "ai-demo.log");

  runChecked([
    "scripts/run-demo-ai-sidecar.mjs",
    "--daemon",
    "--port",
    String(sidecarPort),
    "--video-port",
    String(videoPort),
    "--audio-port",
    String(audioPort),
    "--pid-file",
    pidFile,
    "--log-file",
    logFile,
  ]);

  sidecarPid = Number(readFileSync(pidFile, "utf8").trim());
  if (!Number.isInteger(sidecarPid) || sidecarPid <= 0) {
    throw new Error("daemon pid file did not contain a valid pid");
  }

  const health = await waitForHealth(sidecarPort, logFile);
  assert(health.status === "ready", "daemon health was not ready");
  assert(health.mode === "adapter-contract", "daemon was not in demo mode");
  assert(
    health.diagnostics?.managedProcessors?.some(
      (processor) => processor.id === "video" && processor.status === "running",
    ),
    "daemon video processor was not running",
  );
  assert(
    health.diagnostics?.managedProcessors?.some(
      (processor) => processor.id === "audio" && processor.status === "running",
    ),
    "daemon audio processor was not running",
  );

  console.log("ai demo daemon smoke ok");
} finally {
  if (sidecarPid) stopPid(sidecarPid);
  rmSync(tempDir, { recursive: true, force: true });
}

function runChecked(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`${args[0]} failed with ${result.status}`);
  }
}

async function waitForHealth(port, logFile) {
  const deadline = Date.now() + 30_000;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return await response.json();
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }

  const log = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
  throw new Error(
    [
      `daemon did not become healthy: ${lastError?.message ?? "unknown"}`,
      log.slice(-2000),
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

async function getFreePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : null;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!port) throw new Error("No se pudo reservar puerto libre.");
  return port;
}

function stopPid(pid) {
  try {
    process.kill(pid, "SIGINT");
  } catch {
    return;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
