import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "shape-model-preflight-smoke-"));
const videoPort = await getFreePort();
const audioPort = await getFreePort();

try {
  const envPath = join(tempDir, "shape-ai-runtime.env");
  const framePath = join(tempDir, "frame.jpg");
  const identityPath = join(tempDir, "identity.jpg");
  const cleanPlatePath = join(tempDir, "clean-plate.jpg");
  const audioPath = join(tempDir, "audio.f32le");

  writeFileSync(framePath, tinyJpeg());
  writeFileSync(identityPath, tinyJpeg());
  writeFileSync(cleanPlatePath, tinyJpeg());
  writeFileSync(audioPath, Buffer.alloc(480 * 4));

  runChecked([
    "scripts/prepare-ai-runtime-models.mjs",
    "--",
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

  const report = runPreflight({
    envPath,
    framePath,
    identityPath,
    cleanPlatePath,
    audioPath,
  });

  assert(report.preflight?.status === "passed", "preflight did not pass");
  assert(
    report.preflight?.checks?.some(
      (check) =>
        check.id === "video" &&
        check.processor === "shape-video-model-chain:face+background",
    ),
    "video preflight did not use face/background command chain",
  );
  assert(
    report.preflight?.checks?.some(
      (check) =>
        check.id === "audio" &&
        check.processor === "shape-voice-command-adapter",
    ),
    "audio preflight did not use voice command adapter",
  );
  assert(
    report.health?.diagnostics?.managedProcessors?.some(
      (processor) => processor.id === "video" && processor.status === "running",
    ),
    "video managed processor was not running",
  );
  assert(
    report.health?.diagnostics?.managedProcessors?.some(
      (processor) => processor.id === "audio" && processor.status === "running",
    ),
    "audio managed processor was not running",
  );
  const voicePipeline = report.preflight?.session?.pipelines?.find(
    (pipeline) => pipeline.id === "voice",
  );
  assert(
    voicePipeline?.latencyMs ===
      report.preflight?.session?.lastProcessed?.audio?.latencyMs,
    "voice pipeline did not expose audio latency",
  );

  const failingEnvPath = join(tempDir, "shape-ai-runtime-failing.env");
  writeFileSync(
    failingEnvPath,
    replaceEnvValue(
      readFileSync(envPath, "utf8"),
      "SHAPE_FACE_COMMAND",
      nodeSnippetCommand(
        "process.stderr.write('[shape-wrapper] FaceFusion runtime missing identity'); process.exit(7)",
      ),
    ),
  );
  const failedReport = runPreflight(
    {
      envPath: failingEnvPath,
      framePath,
      identityPath,
      cleanPlatePath,
      audioPath,
    },
    { expectFailure: true },
  );
  const failedVideoCheck = failedReport.preflight?.checks?.find(
    (check) => check.id === "video",
  );
  assert(
    failedReport.preflight?.status === "failed",
    "failing model command did not fail preflight",
  );
  assert(
    failedVideoCheck?.status === "error",
    "failing model command did not mark video check as error",
  );
  assert(
    failedVideoCheck?.warnings?.some(
      (warning) =>
        warning.includes("face:model_command_failed:7") &&
        warning.includes("shape-wrapper: FaceFusion runtime missing identity"),
    ),
    `failing model command did not preserve wrapper detail: ${JSON.stringify(failedVideoCheck?.warnings)}`,
  );

  console.log("model preflight smoke ok");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

function runPreflight(
  { envPath, framePath, identityPath, cleanPlatePath, audioPath },
  options = {},
) {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/preflight-ai-runtime-models.mjs",
      "--json",
      "--env-file",
      envPath,
      "--frame",
      framePath,
      "--identity",
      identityPath,
      "--clean-plate",
      cleanPlatePath,
      "--audio",
      audioPath,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );

  if (result.status !== 0 && !options.expectFailure) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`models preflight failed with ${result.status}`);
  }
  if (result.status === 0 && options.expectFailure) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error("models preflight should have failed");
  }

  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw error;
  }
}

function replaceEnvValue(content, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(content)) return content.replace(pattern, line);
  return `${content.trimEnd()}\n${line}\n`;
}

function nodeSnippetCommand(source) {
  return `${process.execPath} -e ${JSON.stringify(source)}`;
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

function tinyJpeg() {
  return Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Al//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z",
    "base64",
  );
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
