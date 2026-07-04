import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "shape-demo-debug-"));
const fixtureDsn = "https://publickey@example.ingest.us.sentry.io/123";

try {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/export-demo-debug-bundle.mjs",
      "--output-dir",
      tempDir,
      "--sentry-live",
      "--skip-services",
      "--skip-real-check",
      "--skip-remote",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        SENTRY_DSN: fixtureDsn,
        NEXT_PUBLIC_SENTRY_DSN: fixtureDsn,
        VITE_SENTRY_DSN: fixtureDsn,
        SHAPE_SENTRY_CHECK_LIVE_STATUS: "403",
        SHAPE_SENTRY_CHECK_LIVE_BODY:
          '{"detail":"event submission rejected with_reason: ProjectId"}',
      },
    },
  );

  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`debug bundle smoke failed with ${result.status}`);
  }

  const bundlePath = readdirSync(tempDir)
    .filter((file) => /^shape-demo-debug-.*\.json$/.test(file))
    .map((file) => join(tempDir, file))
    .at(0);
  assert(bundlePath, "debug bundle JSON was not written");

  const rawBundle = readFileSync(bundlePath, "utf8");
  const bundle = JSON.parse(rawBundle);
  assert(
    bundle.observability.sentry.live === true,
    "sentry live flag was not preserved",
  );
  assert(
    bundle.observability.sentry.report.live === true,
    "sentry report did not run in live mode",
  );
  assert(
    bundle.observability.sentry.report.liveResults?.[0]?.transport ===
      "envelope",
    "sentry live check did not use envelope transport",
  );
  assert(
    bundle.observability.sentry.report.liveResults?.[0]?.eventId,
    "sentry live check did not include an event id",
  );
  assert(
    bundle.observability.sentry.report.issues?.some((issue) =>
      issue.includes("ProjectId"),
    ),
    "sentry live failure did not include ProjectId guidance",
  );
  assert(
    bundle.demo.status.command.includes("--sentry-live"),
    "demo status command did not include --sentry-live",
  );
  assert(
    bundle.demo.status.command.includes("--skip-services"),
    "demo status command did not forward --skip-services",
  );
  assert(
    bundle.demo.status.command.includes("--skip-real-check"),
    "demo status command did not forward --skip-real-check",
  );
  assert(
    !rawBundle.includes(fixtureDsn),
    "debug bundle leaked a raw Sentry DSN",
  );

  console.log("demo debug bundle smoke ok");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
