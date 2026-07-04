import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "shape-sentry-local-"));
const liveTempDir = mkdtempSync(join(tmpdir(), "shape-sentry-live-"));
const failTempDir = mkdtempSync(join(tmpdir(), "shape-sentry-live-fail-"));

try {
  writeFixture(
    ".env.local",
    "DATABASE_URL=postgres://example\nSENTRY_DEBUG=false\n",
  );
  writeFixture(
    join("apps", "admin", ".env.local"),
    "NEXT_PUBLIC_APP_URL=http://localhost:3000\n",
  );

  execFileSync(
    process.execPath,
    [
      resolve("scripts/configure-sentry-local.mjs"),
      "--root",
      tempDir,
      "--dsn",
      "https://publickey@example.ingest.us.sentry.io/123",
      "--environment",
      "internal-debug",
      "--debug",
      "true",
      "--traces-sample-rate",
      "0.5",
      "--release-suffix",
      "test",
    ],
    { stdio: "pipe" },
  );

  assertFileIncludes(".env.local", "DATABASE_URL=postgres://example");
  assertFileIncludes(".env.local", "SENTRY_DEBUG=true");
  assertFileIncludes(
    ".env.local",
    "VITE_SENTRY_DSN=https://publickey@example.ingest.us.sentry.io/123",
  );
  assertFileIncludes(
    ".env.local",
    "NEXT_PUBLIC_SENTRY_RELEASE=shape-meet-admin@test",
  );
  assertFileIncludes(
    join("apps", "admin", ".env.local"),
    "NEXT_PUBLIC_APP_URL=http://localhost:3000",
  );
  assertFileIncludes(
    join("apps", "admin", ".env.local"),
    "SENTRY_RELEASE=shape-meet-admin@test",
  );
  assertFileIncludes(
    join("apps", "desktop", ".env.local"),
    "SENTRY_RELEASE=shape-meet-desktop@test",
  );
  assertFileIncludes(
    join("apps", "desktop", ".env.local"),
    "VITE_SENTRY_DEBUG=true",
  );

  const sentryJson = execFileSync(
    process.execPath,
    [resolve("scripts/check-sentry-config.mjs"), "--json", "--root", tempDir],
    {
      encoding: "utf8",
    },
  );
  const sentryReport = JSON.parse(sentryJson);
  assert(sentryReport.ok === true, "sentry JSON check did not pass");
  assert(
    sentryReport.checks.length >= 5,
    "sentry JSON check did not include all surfaces",
  );
  assert(
    !sentryJson.includes("https://publickey@example.ingest.us.sentry.io/123"),
    "sentry JSON leaked raw DSN",
  );

  const liveCheckJson = execFileSync(
    process.execPath,
    [
      resolve("scripts/check-sentry-config.mjs"),
      "--json",
      "--live",
      "--root",
      tempDir,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        SHAPE_SENTRY_CHECK_LIVE_STATUS: "200",
      },
    },
  );
  const liveCheckReport = JSON.parse(liveCheckJson);
  assert(liveCheckReport.ok === true, "sentry live fixture did not pass");
  assert(
    liveCheckReport.liveResults?.[0]?.transport === "envelope",
    "sentry live check did not use envelope transport",
  );
  assert(
    liveCheckReport.liveResults?.[0]?.eventId,
    "sentry live check did not report event id",
  );

  const liveCheckFail = spawnSync(
    process.execPath,
    [
      resolve("scripts/check-sentry-config.mjs"),
      "--json",
      "--live",
      "--root",
      tempDir,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        SHAPE_SENTRY_CHECK_LIVE_STATUS: "403",
        SHAPE_SENTRY_CHECK_LIVE_BODY:
          '{"detail":"event submission rejected with_reason: ProjectId"}',
      },
    },
  );
  assert(liveCheckFail.status !== 0, "invalid sentry live check should fail");
  const liveCheckFailReport = JSON.parse(liveCheckFail.stdout);
  assert(
    liveCheckFailReport.liveResults?.[0]?.transport === "envelope",
    "failing sentry live check did not use envelope transport",
  );
  assert(
    liveCheckFailReport.issues?.some((issue) => issue.includes("ProjectId")),
    "failing sentry live check did not explain ProjectId",
  );

  execFileSync(
    process.execPath,
    [
      resolve("scripts/configure-sentry-local.mjs"),
      "--root",
      liveTempDir,
      "--dsn",
      "https://publickey@example.ingest.us.sentry.io/123",
      "--verify-live",
    ],
    {
      stdio: "pipe",
      env: {
        ...process.env,
        SHAPE_SENTRY_CONFIGURE_LIVE_STATUS: "200",
      },
    },
  );
  assertFileIncludesIn(
    liveTempDir,
    ".env.local",
    "SENTRY_DSN=https://publickey@example.ingest.us.sentry.io/123",
  );

  const failResult = spawnSync(
    process.execPath,
    [
      resolve("scripts/configure-sentry-local.mjs"),
      "--root",
      failTempDir,
      "--dsn",
      "https://publickey@example.ingest.us.sentry.io/123",
      "--verify-live",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        SHAPE_SENTRY_CONFIGURE_LIVE_STATUS: "403",
        SHAPE_SENTRY_CONFIGURE_LIVE_BODY:
          '{"detail":"event submission rejected with_reason: ProjectId"}',
      },
    },
  );
  assert(failResult.status !== 0, "invalid live DSN should fail");
  assert(
    failResult.stderr.includes("ProjectId"),
    "invalid live DSN did not explain ProjectId",
  );
  assert(
    !existsSync(join(failTempDir, ".env.local")),
    "invalid live DSN should not write env files",
  );

  console.log("sentry local config smoke ok");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
  rmSync(liveTempDir, { recursive: true, force: true });
  rmSync(failTempDir, { recursive: true, force: true });
}

function writeFixture(file, content) {
  const target = join(tempDir, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, { flag: "w" });
}

function assertFileIncludes(file, expected) {
  assertFileIncludesIn(tempDir, file, expected);
}

function assertFileIncludesIn(root, file, expected) {
  const target = join(root, file);
  if (!existsSync(target)) {
    throw new Error(`expected file to exist: ${file}`);
  }
  const content = readFileSync(target, "utf8");
  if (!content.includes(expected)) {
    throw new Error(`expected ${file} to include ${expected}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
