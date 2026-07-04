import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "shape-coolify-handoff-"));

try {
  smokeGeneratedProductionHandoff();
  smokeExampleHandoff();
  console.log("coolify handoff smoke ok");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

function smokeGeneratedProductionHandoff() {
  const out = join(tempDir, "generated");
  const result = run([
    "--json",
    "--out",
    out,
    "--admin-domain",
    "admin.shape-demo.test",
    "--meeting-domain",
    "meet.shape-demo.test",
    "--livekit-domain",
    "livekit.shape-demo.test",
    "--turn-domain",
    "turn.shape-demo.test",
    "--public-ip",
    "8.8.8.8",
    "--bootstrap-email",
    "admin@shape-demo.test",
    "--strict",
  ]);

  assert(result.status === 0, "generated handoff failed");
  const report = JSON.parse(result.stdout);
  assert(report.ok === true, "generated report was not ok");
  assert(report.strict === true, "strict flag missing");
  assert(
    report.coolify.adminUrl === "https://admin.shape-demo.test",
    "admin url mismatch",
  );
  assert(
    report.coolify.livekitUrl === "wss://livekit.shape-demo.test",
    "livekit url mismatch",
  );
  assert(
    report.coolify.turnDomain === "turn.shape-demo.test",
    "turn domain mismatch",
  );
  assert(existsSync(join(out, "shape-meet.coolify.env")), "env not written");
  assert(
    existsSync(join(out, "docker-compose.coolify.yml")),
    "compose not copied",
  );
  assert(existsSync(join(out, "README.md")), "readme not written");
  assert(existsSync(join(out, "manifest.json")), "manifest not written");
  assert(
    existsSync(join(out, "bootstrap-password.txt")),
    "bootstrap password not written",
  );

  const env = readFileSync(join(out, "shape-meet.coolify.env"), "utf8");
  assert(
    /CORS_ORIGIN="?https:\/\/admin\.shape-demo\.test,https:\/\/meet\.shape-demo\.test"?/m.test(
      env,
    ),
    "generated env did not include admin and meeting CORS origins",
  );

  const readme = readFileSync(join(out, "README.md"), "utf8");
  assert(readme.includes("Shape Meet Coolify Handoff"), "readme title missing");
  assert(
    readme.includes("Resource type: Docker Compose"),
    "resource instructions missing",
  );
  assert(readme.includes("pnpm demo:remote:check"), "remote check missing");
}

function smokeExampleHandoff() {
  const out = join(tempDir, "example");
  const result = run(["--json", "--out", out]);

  assert(result.status === 0, "example handoff failed");
  const report = JSON.parse(result.stdout);
  assert(report.ok === true, "example report was not ok");
  assert(report.strict === false, "example should not be strict");
  assert(
    report.sourceEnvFile.endsWith("infra/env.coolify.example"),
    "example env source mismatch",
  );
}

function run(args) {
  const result = spawnSync(
    process.execPath,
    ["scripts/prepare-coolify-handoff.mjs", ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }

  return result;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
