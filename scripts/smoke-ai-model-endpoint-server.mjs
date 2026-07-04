import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const python =
  process.env.SHAPE_AI_SMOKE_PYTHON ?? process.env.SHAPE_AI_PYTHON ?? "python3";
const tempDir = mkdtempSync(join(tmpdir(), "shape-model-endpoint-smoke-"));
const endpointPort = await getFreePort();
const videoPort = await getFreePort();
const audioPort = await getFreePort();
const envPath = join(tempDir, "shape-ai-runtime.env");
let endpointServer = null;

try {
  endpointServer = spawn(
    process.execPath,
    [
      "scripts/run-model-endpoint-server.mjs",
      "--host",
      "127.0.0.1",
      "--port",
      String(endpointPort),
      "--python",
      python,
      "--passthrough",
    ],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        SHAPE_MODEL_ENDPOINT_ACCESS_LOG: "false",
      },
    },
  );

  const endpointOutput = captureProcessOutput(endpointServer);
  await waitForEndpoint(endpointOutput);
  renderRuntimeEnv();
  assertLocalEndpointRuntimeEnv();

  const report = runPreflight();
  assert(
    report.preflight?.status === "passed",
    "endpoint preflight did not pass",
  );
  assert(
    report.preflight?.checks?.some(
      (check) =>
        check.id === "video" &&
        check.processor === "shape-video-model-chain:face+background",
    ),
    "video preflight did not use face/background endpoint chain",
  );
  assert(
    report.preflight?.checks?.some(
      (check) =>
        check.id === "audio" &&
        check.processor === "shape-voice-endpoint-adapter",
    ),
    "audio preflight did not use voice endpoint adapter",
  );
  assert(
    report.health?.diagnostics?.engines?.some(
      (engine) => engine.id === "face" && engine.status === "ready",
    ),
    "face engine was not ready with endpoint runtime",
  );

  console.log("model endpoint server smoke ok");
} finally {
  if (endpointServer) endpointServer.kill();
  rmSync(tempDir, { recursive: true, force: true });
}

function renderRuntimeEnv() {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/prepare-ai-runtime-models.mjs",
      "--out",
      envPath,
      "--preset",
      "local-endpoints",
      "--video-port",
      String(videoPort),
      "--audio-port",
      String(audioPort),
      "--model-endpoint-host",
      "127.0.0.1",
      "--model-endpoint-port",
      String(endpointPort),
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
    },
  );

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert(
    result.status === 0,
    `runtime generation failed with ${result.status}`,
  );
}

function assertLocalEndpointRuntimeEnv() {
  const report = spawnSync(
    process.execPath,
    [
      "scripts/check-ai-model-runtime.mjs",
      "--env-file",
      envPath,
      "--skip-hardware",
      "--skip-wrapper-smoke",
      "--json",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
    },
  );

  if (report.stderr) process.stderr.write(report.stderr);
  assert(report.status === 0, `models doctor failed with ${report.status}`);
  const parsed = JSON.parse(report.stdout);
  assert(
    parsed.realModelReadiness?.ready === true,
    "endpoint runtime was not ready",
  );
}

function runPreflight() {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/preflight-ai-runtime-models.mjs",
      "--json",
      "--env-file",
      envPath,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
    },
  );

  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    throw new Error(`models preflight failed with ${result.status}`);
  }

  return JSON.parse(result.stdout);
}

async function waitForEndpoint(output) {
  const url = `http://127.0.0.1:${endpointPort}/health`;
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    if (endpointServer.exitCode !== null) {
      fail(
        [
          `model endpoint exited early with ${endpointServer.exitCode}`,
          output.stdout.trim(),
          output.stderr.trim(),
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }

    try {
      const response = await fetch(url);
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.status === "ready") return;
    } catch {
      // keep waiting
    }

    await sleep(250);
  }

  fail(
    [
      "model endpoint did not become ready",
      output.stdout.trim(),
      output.stderr.trim(),
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

function captureProcessOutput(child) {
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => {
    output.stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output.stderr += chunk.toString();
  });
  return output;
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
  assert(port, "could not allocate a free port");
  return port;
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function fail(message) {
  throw new Error(message);
}
