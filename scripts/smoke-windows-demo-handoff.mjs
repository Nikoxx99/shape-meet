import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "shape-windows-handoff-"));

try {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/prepare-windows-demo-handoff.mjs",
      "--json",
      "--out",
      tempDir,
      "--api-url",
      "https://admin.example.test",
      "--meeting-url",
      "https://meet.example.test",
      "--ai-url",
      "http://127.0.0.1:7851",
      "--host-identifier",
      "host@example.test",
      "--sentry-dsn",
      "https://public@example.ingest.us.sentry.io/123",
      "--sentry-debug",
      "true",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`windows handoff smoke failed with ${result.status}`);
  }

  const report = JSON.parse(result.stdout);
  assert(report.ok === true, "report was not ok");
  assert(
    report.config.apiUrl === "https://admin.example.test",
    "api url mismatch",
  );
  assert(
    report.config.meetingUrl === "https://meet.example.test",
    "meeting url mismatch",
  );
  assert(
    report.config.sentryConfigured === true,
    "sentry should be configured",
  );
  assert(report.diagnosticScript, "diagnostic script missing from report");
  assert(report.aiRuntimeConfig, "ai runtime config missing from report");
  assert(
    report.installAiRuntimeScript,
    "install ai runtime script missing from report",
  );
  assert(
    report.modelEndpointScript,
    "model endpoint script missing from report",
  );
  assert(
    report.config.modelEndpointBaseUrl === "http://127.0.0.1:9100",
    "model endpoint base URL mismatch",
  );

  const runtime = read("shape-meet.env");
  assert(
    runtime.includes("VITE_SHAPE_API_URL=https://admin.example.test"),
    "runtime api missing",
  );
  assert(
    runtime.includes("VITE_SHAPE_MEETING_URL=https://meet.example.test"),
    "runtime meeting missing",
  );
  assert(
    runtime.includes(
      "VITE_SENTRY_DSN=https://public@example.ingest.us.sentry.io/123",
    ),
    "runtime sentry missing",
  );
  assert(
    !runtime.includes("LIVEKIT_API_SECRET"),
    "runtime leaked LiveKit secret",
  );

  const aiRuntime = read("shape-ai-runtime.env");
  assert(
    aiRuntime.includes("SHAPE_MODEL_RUNTIME_PRESET=local-endpoints"),
    "ai runtime preset missing",
  );
  assert(
    aiRuntime.includes(
      "SHAPE_VIDEO_FRAME_ENDPOINT=http://127.0.0.1:9100/video-frame",
    ),
    "ai runtime combined video endpoint missing",
  );
  assert(
    aiRuntime.includes(
      "SHAPE_AUDIO_CHUNK_ENDPOINT=http://127.0.0.1:9100/voice",
    ),
    "ai runtime audio endpoint missing",
  );

  const script = read("Build-ShapeMeetWindows.ps1");
  assert(script.includes("pnpm build:desktop"), "build command missing");
  assert(script.includes("pnpm desktop:bundle:check"), "bundle check missing");
  assert(
    script.includes("pnpm desktop:handoff -- --local-bundle --copy-local"),
    "handoff command missing",
  );
  assert(script.includes("$env:LOCALAPPDATA"), "runtime install path missing");

  const diagnosticScript = read("Test-ShapeMeetWindows.ps1");
  assert(
    diagnosticScript.includes("AiRuntimeConfig"),
    "ai runtime parameter missing from diagnostic script",
  );
  assert(
    diagnosticScript.includes("RemoteEnvFile"),
    "remote env parameter missing from diagnostic script",
  );
  assert(
    diagnosticScript.includes("pnpm @statusArgs"),
    "demo status command missing from diagnostic script",
  );
  assert(
    diagnosticScript.includes("--verify-handoff"),
    "demo status should verify handoff",
  );
  assert(
    diagnosticScript.includes("pnpm models:doctor"),
    "models doctor command missing from diagnostic script",
  );
  assert(
    diagnosticScript.includes("pnpm demo:doctor -- --no-docker --strict"),
    "demo doctor command missing from diagnostic script",
  );
  assert(
    diagnosticScript.includes("pnpm check:sentry:live"),
    "sentry live command missing from diagnostic script",
  );
  assert(
    diagnosticScript.includes("SHAPE_DEMO_API_URL"),
    "demo env alias missing from diagnostic script",
  );
  assert(
    diagnosticScript.includes("pnpm @debugArgs"),
    "debug bundle command missing from diagnostic script",
  );
  assert(
    diagnosticScript.includes("output/windows-debug"),
    "debug bundle output dir missing from diagnostic script",
  );

  const installAiRuntimeScript = read("Install-ShapeMeetAiRuntime.ps1");
  assert(
    installAiRuntimeScript.includes("shape-ai-runtime.env"),
    "install AI runtime script did not copy runtime env",
  );
  assert(
    installAiRuntimeScript.includes("$env:LOCALAPPDATA"),
    "install AI runtime script did not target app data",
  );

  const endpointScript = read("Start-ShapeMeetModelEndpoint.ps1");
  assert(
    endpointScript.includes("pnpm @endpointArgs"),
    "model endpoint script did not start pnpm endpoint",
  );
  assert(
    endpointScript.includes("--demo-effects"),
    "model endpoint script did not support demo effects",
  );

  const readme = read("README.md");
  assert(
    readme.includes("Shape Meet Windows Demo Handoff"),
    "readme title missing",
  );
  assert(
    readme.includes("Test-ShapeMeetWindows.ps1"),
    "diagnostic script missing from readme",
  );
  assert(readme.includes("Windows AMD Ryzen"), "limited Windows note missing");
  assert(
    readme.includes("Start-ShapeMeetModelEndpoint.ps1"),
    "model endpoint script missing from readme",
  );
  assert(
    readme.includes("-DemoEffects"),
    "demo effects path missing from readme",
  );
  assert(existsSync(join(tempDir, "manifest.json")), "manifest missing");

  console.log("windows demo handoff smoke ok");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

function read(file) {
  return readFileSync(join(tempDir, file), "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
