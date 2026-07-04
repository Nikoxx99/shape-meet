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

const tempDir = mkdtempSync(join(tmpdir(), "shape-demo-handoff-"));

try {
  const runId = 987654321;
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
      "scripts/package-demo-handoff.mjs",
      "--json",
      "--output-dir",
      tempDir,
      "--skip-prepare",
      "--skip-debug",
      "--skip-real-check",
      "--skip-model-bootstrap",
      "--desktop-mode",
      "github",
      "--repo",
      "Luxora-Agency/shape-meet",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
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
    throw new Error(`demo handoff smoke failed with ${result.status}`);
  }

  const report = JSON.parse(result.stdout);
  assert(report.ok === true, "demo handoff report was not ok");
  assert(
    report.steps.localPreview.ok === true,
    "local preview step did not pass",
  );
  assert(report.steps.desktop.ok === true, "desktop step did not pass");
  assert(report.steps.desktop.mode === "github", "desktop mode mismatch");
  assert(
    report.demo.desktop.artifacts.includes("shape-meet-windows-x64"),
    "desktop artifacts were not summarized",
  );

  const manifestPath = join(tempDir, "manifest.json");
  const readmePath = join(tempDir, "README.md");
  assert(existsSync(manifestPath), "manifest not written");
  assert(existsSync(readmePath), "README not written");

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert(manifest.artifacts.manifest === manifestPath, "manifest path missing");
  assert(manifest.artifacts.readme === readmePath, "readme path missing");
  assert(
    manifest.artifacts.desktopHandoff.endsWith("desktop-handoff/github"),
    "desktop handoff output missing",
  );

  const readme = readFileSync(readmePath, "utf8");
  assert(readme.includes("Shape Meet Demo Handoff"), "README title missing");
  assert(readme.includes("Preview local IA: ok"), "README preview missing");
  assert(readme.includes("Desktop handoff: ok"), "README status missing");
  assert(readme.includes("shape-meet-windows-x64"), "README artifact missing");

  smokeRemoteFlowInference();

  console.log("demo handoff smoke ok");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

function smokeRemoteFlowInference() {
  const remoteEnvPath = join(tempDir, "remote.env");
  const artifactPath = join(tempDir, "identity.bin");
  writeFileSync(
    remoteEnvPath,
    [
      "NEXT_PUBLIC_APP_URL=https://admin.example.test",
      "LIVEKIT_URL=wss://livekit.example.test",
      "LIVEKIT_TURN_DOMAIN=turn.example.test",
      "HOST_BOOTSTRAP_EMAIL=host@example.test",
      "HOST_BOOTSTRAP_PASSWORD=Host123456!",
      "",
    ].join("\n"),
  );
  writeFileSync(artifactPath, "identity-smoke");

  const result = spawnSync(
    process.execPath,
    [
      "scripts/package-demo-handoff.mjs",
      "--json",
      "--output-dir",
      join(tempDir, "remote-inference"),
      "--skip-prepare",
      "--skip-debug",
      "--skip-real-check",
      "--skip-local-preview",
      "--skip-identity-push",
      "--skip-desktop",
      "--skip-model-bootstrap",
      "--remote-env-file",
      remoteEnvPath,
      "--identity-artifact-file",
      artifactPath,
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
    throw new Error(`remote flow inference smoke failed with ${result.status}`);
  }

  const report = JSON.parse(result.stdout);
  assert(report.ok === true, "remote inference report was not ok");
  assert(
    report.options.remoteApiFlow === true,
    "remote api flow was not inferred from remote env",
  );
  assert(
    report.options.remoteIdentityFlow === true,
    "remote identity flow was not inferred from identity artifact",
  );
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
