import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "shape-desktop-handoff-"));

try {
  const runId = 123456789;
  const currentHead = "abc123";
  const run = {
    databaseId: runId,
    status: "completed",
    conclusion: "success",
    url: `https://github.com/Luxora-Agency/shape-meet/actions/runs/${runId}`,
    name: "Desktop Packages",
    event: "workflow_dispatch",
    createdAt: "2026-07-04T00:00:00Z",
    headSha: currentHead,
  };
  const artifacts = [
    artifact("shape-meet-runtime-config", 471),
    artifact("shape-meet-windows-x64", 51_911_546),
    artifact("shape-meet-macos-arm64", 54_755_634),
    artifact("shape-meet-macos-x64", 55_461_244),
  ];
  const result = spawnSync(
    process.execPath,
    [
      "scripts/prepare-desktop-demo-handoff.mjs",
      "--json",
      "--repo",
      "Luxora-Agency/shape-meet",
      "--out",
      tempDir,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        SHAPE_DESKTOP_HANDOFF_CURRENT_HEAD: currentHead,
        SHAPE_DESKTOP_HANDOFF_RUNS_JSON: JSON.stringify([run]),
        SHAPE_DESKTOP_HANDOFF_ARTIFACTS_JSON: JSON.stringify({ artifacts }),
      },
    },
  );

  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`desktop handoff smoke failed with ${result.status}`);
  }

  const report = JSON.parse(result.stdout);
  assert(report.ok === true, "handoff report was not ok");
  assert(
    report.artifacts.length === 4,
    "handoff did not include all artifacts",
  );
  assert(existsSync(join(tempDir, "manifest.json")), "manifest not written");
  assert(existsSync(join(tempDir, "README.md")), "README not written");

  const manifest = JSON.parse(
    readFileSync(join(tempDir, "manifest.json"), "utf8"),
  );
  assert(manifest.run.databaseId === runId, "manifest run id mismatch");
  assert(manifest.headMatchesCurrent === true, "manifest did not match HEAD");
  assert(
    readFileSync(join(tempDir, "README.md"), "utf8").includes(
      "shape-meet-windows-x64",
    ),
    "README did not list artifacts",
  );

  const staleResult = spawnSync(
    process.execPath,
    [
      "scripts/prepare-desktop-demo-handoff.mjs",
      "--json",
      "--repo",
      "Luxora-Agency/shape-meet",
      "--out",
      join(tempDir, "stale"),
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        SHAPE_DESKTOP_HANDOFF_CURRENT_HEAD: "def456",
        SHAPE_DESKTOP_HANDOFF_RUNS_JSON: JSON.stringify([run]),
        SHAPE_DESKTOP_HANDOFF_ARTIFACTS_JSON: JSON.stringify({ artifacts }),
      },
    },
  );
  if (staleResult.status === 0) {
    if (staleResult.stdout) process.stdout.write(staleResult.stdout);
    if (staleResult.stderr) process.stderr.write(staleResult.stderr);
    throw new Error("stale desktop handoff should fail by default");
  }
  const staleReport = JSON.parse(staleResult.stdout);
  assert(
    staleReport.headMatchesCurrent === false,
    "stale handoff did not report commit mismatch",
  );

  const localBundleDir = join(tempDir, "bundle");
  const localOutputDir = join(tempDir, "local-handoff");
  mkdirSync(join(localBundleDir, "dmg"), { recursive: true });
  writeFileSync(
    join(localBundleDir, "dmg", "Shape Meet_0.1.0_aarch64.dmg"),
    "demo",
  );
  const localResult = spawnSync(
    process.execPath,
    [
      "scripts/prepare-desktop-demo-handoff.mjs",
      "--json",
      "--local-bundle",
      "--skip-bundle-check",
      "--bundle-dir",
      localBundleDir,
      "--out",
      localOutputDir,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        SHAPE_DESKTOP_HANDOFF_CURRENT_HEAD: currentHead,
      },
    },
  );
  if (localResult.status !== 0) {
    if (localResult.stdout) process.stdout.write(localResult.stdout);
    if (localResult.stderr) process.stderr.write(localResult.stderr);
    throw new Error(
      `local desktop handoff smoke failed with ${localResult.status}`,
    );
  }
  const localReport = JSON.parse(localResult.stdout);
  assert(localReport.ok === true, "local handoff report was not ok");
  assert(
    localReport.source === "local-bundle",
    "local handoff source mismatch",
  );
  assert(
    localReport.artifacts.some((item) => item.name.includes("Shape Meet")),
    "local handoff did not include local artifact",
  );
  assert(
    readFileSync(join(localOutputDir, "README.md"), "utf8").includes(
      "bundle local",
    ),
    "local handoff README did not describe local bundle",
  );

  const billingRun = {
    databaseId: 987654321,
    status: "completed",
    conclusion: "failure",
    url: "https://github.com/Luxora-Agency/shape-meet/actions/runs/987654321",
    name: "Desktop Packages",
    event: "workflow_dispatch",
    createdAt: "2026-07-04T00:00:00Z",
    headSha: currentHead,
  };
  const billingResult = spawnSync(
    process.execPath,
    [
      "scripts/prepare-desktop-demo-handoff.mjs",
      "--json",
      "--repo",
      "Luxora-Agency/shape-meet",
      "--out",
      join(tempDir, "billing"),
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        SHAPE_DESKTOP_HANDOFF_CURRENT_HEAD: currentHead,
        SHAPE_DESKTOP_HANDOFF_RUNS_JSON: JSON.stringify([billingRun]),
        SHAPE_DESKTOP_HANDOFF_ARTIFACTS_JSON: JSON.stringify({ artifacts: [] }),
        SHAPE_DESKTOP_HANDOFF_ANNOTATIONS_JSON: JSON.stringify([
          {
            message:
              "The job was not started because recent account payments have failed or your spending limit needs to be increased.",
          },
        ]),
      },
    },
  );
  if (billingResult.status === 0) {
    if (billingResult.stdout) process.stdout.write(billingResult.stdout);
    if (billingResult.stderr) process.stderr.write(billingResult.stderr);
    throw new Error("billing-blocked desktop handoff should fail");
  }
  const billingReport = JSON.parse(billingResult.stdout);
  assert(
    billingReport.ciBlocker?.code === "github-actions-billing",
    "billing blocker was not detected",
  );
  assert(
    readFileSync(join(tempDir, "billing", "README.md"), "utf8").includes(
      "Fallback local",
    ),
    "billing README did not include local fallback",
  );

  console.log("desktop handoff smoke ok");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

function artifact(name, size) {
  return {
    id: `${name}-id`,
    name,
    expired: false,
    size_in_bytes: size,
    created_at: "2026-07-04T00:00:00Z",
    expires_at: "2026-07-18T00:00:00Z",
    archive_download_url: `https://api.github.com/artifacts/${name}.zip`,
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
