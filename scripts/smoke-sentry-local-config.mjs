import { execFileSync } from "node:child_process";
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

  console.log("sentry local config smoke ok");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

function writeFixture(file, content) {
  const target = join(tempDir, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, { flag: "w" });
}

function assertFileIncludes(file, expected) {
  const target = join(tempDir, file);
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
