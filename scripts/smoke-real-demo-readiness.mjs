import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "shape-real-demo-readiness-"));
const videoPort = await getFreePort();
const audioPort = await getFreePort();

try {
  const envPath = join(tempDir, "shape-ai-runtime.env");

  runChecked([
    "scripts/prepare-ai-runtime-models.mjs",
    "--preset",
    "local-wrappers",
    "--passthrough",
    "--out",
    envPath,
    "--video-port",
    String(videoPort),
    "--audio-port",
    String(audioPort),
  ]);

  const result = spawnSync(
    process.execPath,
    [
      "scripts/check-real-demo-readiness.mjs",
      "--json",
      "--skip-sentry",
      "--env-file",
      envPath,
      "--timeout-ms",
      "45000",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 90000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`real demo readiness check failed with ${result.status}`);
  }

  const report = JSON.parse(result.stdout);
  assert(report.ok === true, "readiness report was not ok");
  assert(
    report.steps?.modelDoctor?.ok === true,
    "readiness report did not pass model doctor",
  );
  assert(
    report.steps?.modelPreflight?.ok === true,
    "readiness report did not pass model preflight",
  );
  assert(
    report.steps?.modelPreflight?.checks?.some((check) => check.id === "video"),
    "readiness report did not include video preflight",
  );
  assert(
    report.steps?.modelPreflight?.checks?.some((check) => check.id === "audio"),
    "readiness report did not include audio preflight",
  );
  assert(
    report.steps?.realModels?.realModelsConfigured === false,
    "passthrough smoke should not be marked as real model ready",
  );
  assert(
    report.readyForRealDemo === false,
    "passthrough smoke should not be marked ready for real demo",
  );

  const strictResult = spawnSync(
    process.execPath,
    [
      "scripts/check-real-demo-readiness.mjs",
      "--json",
      "--skip-sentry",
      "--env-file",
      envPath,
      "--timeout-ms",
      "45000",
      "--require-real-models",
      "--skip-model-preflight",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 90000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  if (strictResult.status === 0) {
    if (strictResult.stdout) process.stdout.write(strictResult.stdout);
    if (strictResult.stderr) process.stderr.write(strictResult.stderr);
    throw new Error("require-real-models check should fail with passthrough");
  }

  const strictReport = JSON.parse(strictResult.stdout);
  assert(
    strictReport.steps?.realModels?.ok === false,
    "require-real-models did not fail the realModels step",
  );

  console.log("real demo readiness smoke ok");
} finally {
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
