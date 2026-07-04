import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "shape-demo-status-"));
const outputPath = join(tempDir, "status.json");

try {
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

  console.log("demo status smoke ok");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
