import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "shape-demo-status-"));
const outputPath = join(tempDir, "status.json");
const remoteEnvPath = join(tempDir, "remote.env");

try {
  writeRemoteEnv(remoteEnvPath);
  const result = spawnSync(
    process.execPath,
    [
      "scripts/report-demo-status.mjs",
      "--json",
      "--output",
      outputPath,
      "--skip-services",
      "--skip-sentry",
      "--skip-real-check",
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
    throw new Error(`demo status smoke failed with ${result.status}`);
  }

  const report = JSON.parse(result.stdout);
  assert(report.ok === true, "report should be ok when checks are skipped");
  assert(report.verified.services === false, "services should be skipped");
  assert(report.verified.sentry === false, "sentry should be skipped");
  assert(
    report.verified.realReadiness === false,
    "real readiness should be skipped",
  );
  assert(
    report.checks.services.skipped === true,
    "services step should be marked skipped",
  );
  assert(
    report.readiness.localServices === "not-checked",
    "local services readiness should be not-checked",
  );
  assert(
    report.readiness.remoteDeployment === "not-configured",
    "remote readiness should be not-configured without env",
  );
  assert(
    report.readiness.demoPercent === 0,
    "skipped report should have zero verified percent",
  );
  assert(
    report.nextSteps.some((step) => step.includes("--verify-preview")),
    "next steps should mention preview verification",
  );
  assert(existsSync(outputPath), "output file was not written");

  const written = JSON.parse(readFileSync(outputPath, "utf8"));
  assert(written.generatedAt === report.generatedAt, "output file mismatch");

  const remoteResult = spawnSync(
    process.execPath,
    [
      "scripts/report-demo-status.mjs",
      "--json",
      "--skip-services",
      "--skip-sentry",
      "--skip-real-check",
      "--remote-env-file",
      remoteEnvPath,
      "--skip-network",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  if (remoteResult.status !== 0) {
    if (remoteResult.stdout) process.stdout.write(remoteResult.stdout);
    if (remoteResult.stderr) process.stderr.write(remoteResult.stderr);
    throw new Error(
      `remote demo status smoke failed with ${remoteResult.status}`,
    );
  }

  const remoteReport = JSON.parse(remoteResult.stdout);
  assert(
    remoteReport.verified.remoteDeployment === true,
    "remote deployment should be verified when env is provided",
  );
  assert(
    remoteReport.checks.remoteDeployment.ok === true,
    "remote deployment check should pass with skip-network",
  );
  assert(
    remoteReport.readiness.remoteDeployment === "ok",
    "remote deployment readiness should be ok",
  );
  assert(
    remoteReport.checks.remoteDeployment.target.turnHost ===
      "turn.example.test",
    "remote target turn host mismatch",
  );

  console.log("demo status smoke ok");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function writeRemoteEnv(path) {
  const lines = [
    "NEXT_PUBLIC_APP_URL=https://admin.example.test",
    "VITE_SHAPE_MEETING_URL=https://meet.example.test",
    "LIVEKIT_URL=wss://livekit.example.test",
    "LIVEKIT_TURN_DOMAIN=turn.example.test",
    "LIVEKIT_RTC_TCP_PORT=7881",
    "LIVEKIT_RTC_UDP_PORT=7882",
    "LIVEKIT_TURN_UDP_PORT=3478",
    "LIVEKIT_TURN_TLS_PORT=5349",
    "LIVEKIT_TURN_SHARED_SECRET=remote-smoke-secret",
    "HOST_BOOTSTRAP_EMAIL=admin@example.test",
    "HOST_BOOTSTRAP_PASSWORD=Remote123456!",
    "",
  ];
  writeFileSync(path, lines.join("\n"));
}
