import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "shape-desktop-config-"));
const coolifyEnv = join(tempDir, "coolify.env");

writeFileSync(
  coolifyEnv,
  [
    "VITE_SHAPE_API_URL=https://admin.shape.test",
    "VITE_SHAPE_APP_URL=https://meet.shape.test",
    "VITE_SHAPE_MEETING_URL=https://meet.shape.test",
    "VITE_SHAPE_HOST_IDENTIFIER=host@shape.test",
    "VITE_SENTRY_DSN=https://public@example.ingest.us.sentry.io/123",
    "SENTRY_ENVIRONMENT=internal-debug",
    "VITE_SENTRY_RELEASE=shape-meet-desktop@test",
    "SENTRY_TRACES_SAMPLE_RATE=0.5",
    "SENTRY_DEBUG=true",
    "LIVEKIT_API_SECRET=must-not-leak",
    "POSTGRES_PASSWORD=must-not-leak",
    "",
  ].join("\n"),
);

const output = join(tempDir, "shape-meet.env");
const result = spawnSync(
  pnpmCommand(),
  [
    "desktop:config",
    "--",
    "--env-file",
    coolifyEnv,
    "--ai-url",
    "http://127.0.0.1:7851",
    "--out",
    output,
  ],
  {
    cwd: process.cwd(),
    encoding: "utf8",
  },
);

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) fail(result.error.message);
if (result.status !== 0) fail(`desktop:config exited with ${result.status}`);

const content = readFileSync(output, "utf8");

assertIncludes(content, "SHAPE_API_URL=https://admin.shape.test");
assertIncludes(content, "VITE_SHAPE_MEETING_URL=https://meet.shape.test");
assertIncludes(content, "SHAPE_AI_SERVICE_URL=http://127.0.0.1:7851");
assertIncludes(content, "VITE_SHAPE_HOST_IDENTIFIER=host@shape.test");
assertIncludes(
  content,
  "SENTRY_DSN=https://public@example.ingest.us.sentry.io/123",
);
assertIncludes(content, "VITE_SENTRY_RELEASE=shape-meet-desktop@test");
assertIncludes(content, "SENTRY_TRACES_SAMPLE_RATE=0.5");
assertIncludes(content, "VITE_SENTRY_DEBUG=true");
assertNotIncludes(content, "must-not-leak");
assertNotIncludes(content, "LIVEKIT_API_SECRET");
assertNotIncludes(content, "POSTGRES_PASSWORD");

console.log("desktop runtime config smoke ok");

function assertIncludes(content, expected) {
  if (!content.includes(expected)) {
    fail(`expected desktop config to include: ${expected}\n${content}`);
  }
}

function assertNotIncludes(content, unexpected) {
  if (content.includes(unexpected)) {
    fail(`desktop config leaked unexpected value: ${unexpected}\n${content}`);
  }
}

function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
