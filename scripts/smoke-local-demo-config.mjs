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

const tempDir = mkdtempSync(join(tmpdir(), "shape-demo-local-config-"));

try {
  writeFixture(
    ".env.local",
    "SENTRY_DSN=https://public@example.ingest.us.sentry.io/123\n",
  );
  writeFixture(
    join("apps", "desktop", ".env.local"),
    "VITE_SENTRY_DSN=https://public@example.ingest.us.sentry.io/123\n",
  );

  execFileSync(
    process.execPath,
    [
      resolve("scripts/configure-local-demo-env.mjs"),
      "--root",
      tempDir,
      "--host",
      "demo@shape.test",
      "--password",
      "Demo123!",
    ],
    { stdio: "pipe" },
  );

  assertFileIncludes(
    ".env.local",
    "SENTRY_DSN=https://public@example.ingest.us.sentry.io/123",
  );
  assertFileIncludes(".env.local", "LIVEKIT_URL=ws://localhost:17880");
  assertFileIncludes(
    ".env.local",
    "SHAPE_DEMO_LIVEKIT_URL=ws://localhost:17880",
  );
  assertFileIncludes(".env.local", "VITE_SHAPE_API_URL=http://localhost:13000");
  assertFileIncludes(".env.local", "HOST_BOOTSTRAP_EMAIL=demo@shape.test");
  assertFileIncludes(
    join("apps", "admin", ".env.local"),
    'DATABASE_URL="postgresql://shape_meet:shape_meet@localhost:55433/shape_meet?schema=public"',
  );
  assertFileIncludes(
    join("apps", "admin", ".env.local"),
    "LIVEKIT_URL=ws://localhost:17880",
  );
  assertFileIncludes(
    join("apps", "desktop", ".env.local"),
    "VITE_SENTRY_DSN=https://public@example.ingest.us.sentry.io/123",
  );
  assertFileIncludes(
    join("apps", "desktop", ".env.local"),
    "VITE_SHAPE_MEETING_URL=http://localhost:1420",
  );

  console.log("local demo config smoke ok");
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
