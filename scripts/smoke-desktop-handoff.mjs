import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "shape-desktop-handoff-"));

try {
  const runId = 123456789;
  const run = {
    databaseId: runId,
    status: "completed",
    conclusion: "success",
    url: `https://github.com/Luxora-Agency/shape-meet/actions/runs/${runId}`,
    name: "Desktop Packages",
    event: "workflow_dispatch",
    createdAt: "2026-07-04T00:00:00Z",
    headSha: "abc123",
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
  assert(
    readFileSync(join(tempDir, "README.md"), "utf8").includes(
      "shape-meet-windows-x64",
    ),
    "README did not list artifacts",
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
