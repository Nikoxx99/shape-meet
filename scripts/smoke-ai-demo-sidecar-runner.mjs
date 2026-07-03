import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";

const sidecarPort = await getFreePort();
const videoPort = await getFreePort();
const audioPort = await getFreePort();
const sidecarUrl = `http://127.0.0.1:${sidecarPort}`;

const sidecar = spawn(
  process.execPath,
  [
    "scripts/run-demo-ai-sidecar.mjs",
    "--host",
    "127.0.0.1",
    "--port",
    String(sidecarPort),
    "--video-port",
    String(videoPort),
    "--audio-port",
    String(audioPort),
  ],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SENTRY_DSN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let stdout = "";
let stderr = "";
sidecar.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});
sidecar.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

try {
  await waitForSidecar();
  await waitForManagedProcessors();

  const health = await request("/health");
  assert(health.status === 200, `health returned ${health.status}`);
  assert(
    health.data.mode === "adapter-contract",
    "sidecar did not start in adapter-contract mode",
  );
  assert(
    health.data.diagnostics?.managedProcessors?.some(
      (processor) => processor.id === "video" && processor.status === "running",
    ),
    "video demo processor is not running",
  );
  assert(
    health.data.diagnostics?.managedProcessors?.some(
      (processor) => processor.id === "audio" && processor.status === "running",
    ),
    "audio demo processor is not running",
  );

  const preflight = await request("/preflight", {
    method: "POST",
    body: {
      meetingCode: "SM-DEMO-RUNNER",
      participantId: "demo_runner",
      identityId: "identity_demo_runner",
      identityKind: "PHOTO_IDENTITY",
      identityVersion: "demo-runner-v1",
      identityArtifactUri: "shape://demo-runner/identity",
      identityCachedArtifactUri: "shape://demo-runner/identity",
      identityLocalArtifactPath: "",
      identityArtifactSha256: "demo-runner",
      identityArtifactSizeBytes: 32,
      faceEnabled: true,
      backgroundEnabled: true,
      backgroundCleanPlateDataUrl: "data:image/png;base64,iVBORw0KGgo=",
      backgroundCleanPlateCapturedAt: new Date().toISOString(),
      backgroundCleanPlateWidth: 640,
      backgroundCleanPlateHeight: 360,
      backgroundCleanPlateCameraDeviceId: "camera_demo_runner",
      voiceEnabled: true,
      targetWidth: 640,
      targetHeight: 360,
      targetFps: 30,
    },
  });
  assert(preflight.status === 200, `preflight returned ${preflight.status}`);
  assert(
    preflight.data.preflight?.status === "passed",
    "demo runner preflight did not pass",
  );
  assert(
    preflight.data.preflight?.checks?.some(
      (check) =>
        check.id === "video" &&
        check.processor === "shape-demo-video-processor",
    ),
    "preflight did not use demo video processor",
  );
  assert(
    preflight.data.preflight?.checks?.some(
      (check) =>
        check.id === "audio" &&
        check.processor === "shape-demo-audio-processor",
    ),
    "preflight did not use demo audio processor",
  );

  console.log("demo sidecar runner smoke ok");
} finally {
  sidecar.kill();
}

async function request(path, options = {}) {
  const response = await fetch(`${sidecarUrl}${path}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 600) };
  }

  return { status: response.status, data };
}

async function waitForSidecar() {
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    if (sidecar.exitCode !== null) {
      fail(`sidecar exited early with ${sidecar.exitCode}`);
    }

    try {
      const health = await request("/health");
      if (health.status === 200) return;
    } catch {
      // keep waiting
    }

    await sleep(250);
  }

  fail("demo sidecar did not become ready");
}

async function waitForManagedProcessors() {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    try {
      const [video, audio] = await Promise.all([
        fetch(`http://127.0.0.1:${videoPort}/health`),
        fetch(`http://127.0.0.1:${audioPort}/health`),
      ]);
      const [videoData, audioData] = await Promise.all([
        video.json().catch(() => ({})),
        audio.json().catch(() => ({})),
      ]);
      if (
        video.ok &&
        audio.ok &&
        videoData.status === "ready" &&
        audioData.status === "ready"
      ) {
        return;
      }
    } catch {
      // keep waiting
    }

    await sleep(250);
  }

  fail("demo managed processors did not become ready");
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
  console.error(message);
  if (stdout.trim()) console.error(`sidecar stdout:\n${stdout.trim()}`);
  if (stderr.trim()) console.error(`sidecar stderr:\n${stderr.trim()}`);
  process.exit(1);
}
