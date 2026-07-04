// Shared helpers for the phase-1 in-process AI engine smokes
// (smoke:ai-face-inproc / -background-inproc / -collapsed-hops / -stage-states).
//
// Every engine smoke must degrade to a legitimate "skipped" (exit 0) when the
// heavy deps or model weights are absent, so CI on a bare machine is never red
// for environment reasons.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { once } from "node:events";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(scriptDir, "..", "..");
export const fixturesDir = join(repoRoot, "apps", "ai-sidecar", "fixtures");

export function resolveEndpointPython() {
  const explicit =
    process.env.SHAPE_MODEL_ENDPOINT_PYTHON ||
    process.env.SHAPE_AI_SMOKE_PYTHON ||
    process.env.SHAPE_AI_PYTHON;
  if (explicit) return explicit;
  const venv = join(
    repoRoot,
    "apps",
    "ai-sidecar",
    ".venv-inproc",
    "bin",
    "python",
  );
  if (existsSync(venv)) return venv;
  return "python3";
}

export function resolveWeight(envName, ...candidates) {
  const explicit = process.env[envName];
  if (explicit && existsSync(explicit)) return explicit;
  for (const candidate of candidates) {
    const cached = join(
      homedir(),
      ".cache",
      "shape-meet-airuntime",
      "weights",
      candidate,
    );
    if (existsSync(cached)) return cached;
  }
  return null;
}

export function pythonCanImport(python, modules) {
  const code = modules.map((mod) => `import ${mod}`).join("; ");
  return new Promise((resolveP) => {
    const child = spawn(python, ["-c", code], { cwd: repoRoot });
    child.on("error", () => resolveP(false));
    child.on("exit", (exitCode) => resolveP(exitCode === 0));
  });
}

export function spawnModelEndpoint(python, port, extraEnv = {}) {
  return spawn(
    python,
    [
      join(
        "apps",
        "ai-sidecar",
        "processors",
        "shape_model_endpoint_server.py",
      ),
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        SHAPE_MODEL_ENDPOINT_ACCESS_LOG: "false",
        SHAPE_MODEL_ENDPOINT_HOST: "127.0.0.1",
        SHAPE_MODEL_ENDPOINT_PORT: String(port),
        ...extraEnv,
      },
    },
  );
}

export function spawnSidecar(python, port, extraEnv = {}) {
  return spawn(
    python,
    [join("apps", "ai-sidecar", "server.py"), "--port", String(port)],
    {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...extraEnv },
    },
  );
}

export function captureOutput(child) {
  const output = { stdout: "", stderr: "" };
  child.stdout?.on("data", (chunk) => (output.stdout += chunk.toString()));
  child.stderr?.on("data", (chunk) => (output.stderr += chunk.toString()));
  return output;
}

export async function waitForHttpUp(child, port, path, output, attempts = 240) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (child.exitCode !== null) {
      fail(
        `process exited early (${child.exitCode})\n${output.stdout}\n${output.stderr}`,
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      if (response.ok) return;
    } catch {
      // keep waiting
    }
    await sleep(250);
  }
  fail(`process did not answer ${path}\n${output.stdout}\n${output.stderr}`);
}

export async function waitForStageLoaded(
  port,
  stageId,
  output,
  child,
  attempts = 240,
) {
  // Returns the stage's engine state once it is loaded (active|degraded), or
  // "error" if it never loads within the window.
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (child && child.exitCode !== null) {
      fail(
        `endpoint exited early (${child.exitCode})\n${output?.stdout}\n${output?.stderr}`,
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/diagnostics`);
      if (response.ok) {
        const data = await response.json();
        const status = data.diagnostics?.stageStatus?.[stageId];
        if (status && status !== "loading") return status;
      }
    } catch {
      // keep waiting
    }
    await sleep(250);
  }
  return "timeout";
}

export async function getFreePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : null;
  await new Promise((res, rej) =>
    server.close((err) => (err ? rej(err) : res())),
  );
  assert(port, "could not allocate a free port");
  return port;
}

export function imageDataUrl(fileName) {
  const path = join(fixturesDir, fileName);
  return "data:image/jpeg;base64," + readFileSync(path).toString("base64");
}

export async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    data: text ? JSON.parse(text) : {},
    text,
  };
}

export function makeSkip(label) {
  return (reason) => {
    console.log(`${label} skipped: ${reason}`);
    process.exit(0);
  };
}

export function assert(condition, message) {
  if (!condition) fail(message);
}

export function fail(message) {
  throw new Error(message);
}
