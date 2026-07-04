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

  const script = read("Build-ShapeMeetWindows.ps1");
  assert(script.includes("pnpm build:desktop"), "build command missing");
  assert(script.includes("pnpm desktop:bundle:check"), "bundle check missing");
  assert(
    script.includes("pnpm desktop:handoff -- --local-bundle --copy-local"),
    "handoff command missing",
  );
  assert(script.includes("$env:LOCALAPPDATA"), "runtime install path missing");

  const readme = read("README.md");
  assert(
    readme.includes("Shape Meet Windows Demo Handoff"),
    "readme title missing",
  );
  assert(readme.includes("Windows AMD Ryzen"), "limited Windows note missing");
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
