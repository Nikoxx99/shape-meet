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
  assert(report.options.verifyUi === false, "verify UI should be opt-in");
  assert(
    report.steps.fullUiVerify.skipped === true,
    "full UI verify should be skipped by default",
  );
  assert(report.steps.desktop.ok === true, "desktop step did not pass");
  assert(report.steps.desktop.mode === "github", "desktop mode mismatch");
  assert(report.steps.coolify.ok === true, "coolify step did not pass");
  assert(
    report.demo.coolify.firewallRules >= 7,
    "coolify firewall rules were not summarized",
  );
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
  assert(
    manifest.artifacts.coolifyHandoff.endsWith("coolify-handoff"),
    "coolify handoff output missing",
  );

  const readme = readFileSync(readmePath, "utf8");
  assert(readme.includes("Shape Meet Demo Handoff"), "README title missing");
  assert(readme.includes("Preview local IA: ok"), "README preview missing");
  assert(
    readme.includes("Coolify/TURN handoff: ok"),
    "README coolify status missing",
  );
  assert(readme.includes("Coolify/TURN: ok"), "README coolify summary missing");
  assert(
    readme.includes("Verificacion UI completa: omitido"),
    "README full UI verify status missing",
  );
  assert(readme.includes("Desktop handoff: ok"), "README status missing");
  assert(readme.includes("shape-meet-windows-x64"), "README artifact missing");

  smokeRemoteFlowInference();
  smokeVerifyUiSkip();
  smokeCoolifyEnvFile();
  smokeCoolifySecretRedaction();
  smokeModelEndpointBootstrap();

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

function smokeCoolifyEnvFile() {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/package-demo-handoff.mjs",
      "--json",
      "--output-dir",
      join(tempDir, "coolify-env-file"),
      "--skip-prepare",
      "--skip-debug",
      "--skip-real-check",
      "--skip-local-preview",
      "--skip-verify-ui",
      "--skip-identity-push",
      "--skip-desktop",
      "--skip-model-bootstrap",
      "--coolify-env-file",
      "infra/env.coolify.example",
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
    throw new Error(`coolify env-file smoke failed with ${result.status}`);
  }

  const report = JSON.parse(result.stdout);
  assert(report.ok === true, "coolify env-file report was not ok");
  assert(
    report.options.coolifyEnvFile === "infra/env.coolify.example",
    "coolify env-file option missing",
  );
  assert(report.steps.coolify.ok === true, "coolify env-file step failed");
}

function smokeCoolifySecretRedaction() {
  const rawDsn = "https://publickey@example.ingest.us.sentry.io/123";
  const rawToken = "sntrys_very_secret_token";
  const result = spawnSync(
    process.execPath,
    [
      "scripts/package-demo-handoff.mjs",
      "--json",
      "--output-dir",
      join(tempDir, "coolify-redaction"),
      "--skip-prepare",
      "--skip-debug",
      "--skip-real-check",
      "--skip-local-preview",
      "--skip-verify-ui",
      "--skip-identity-push",
      "--skip-desktop",
      "--skip-model-bootstrap",
      "--admin-domain",
      "admin.shape-demo.test",
      "--meeting-domain",
      "meet.shape-demo.test",
      "--livekit-domain",
      "livekit.shape-demo.test",
      "--turn-domain",
      "turn.shape-demo.test",
      "--public-ip",
      "8.8.4.4",
      "--sentry-dsn",
      rawDsn,
      "--sentry-auth-token",
      rawToken,
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
    throw new Error(`coolify redaction smoke failed with ${result.status}`);
  }

  assert(!result.stdout.includes(rawDsn), "raw sentry DSN leaked");
  assert(!result.stdout.includes(rawToken), "raw sentry auth token leaked");
  const report = JSON.parse(result.stdout);
  assert(report.steps.coolify.ok === true, "coolify redaction step failed");
  assert(
    report.steps.coolify.command.includes("<redacted:secret>"),
    "coolify command did not redact secrets",
  );
}

function smokeModelEndpointBootstrap() {
  const outputDir = join(tempDir, "model-endpoint-bootstrap");
  const result = spawnSync(
    process.execPath,
    [
      "scripts/package-demo-handoff.mjs",
      "--json",
      "--output-dir",
      outputDir,
      "--skip-prepare",
      "--skip-debug",
      "--skip-real-check",
      "--skip-local-preview",
      "--skip-verify-ui",
      "--skip-identity-push",
      "--skip-desktop",
      "--skip-coolify",
      "--skip-hardware",
      "--skip-vcclient",
      "--runtime-preset",
      "local-endpoints",
      "--model-endpoint-host",
      "127.0.0.1",
      "--model-endpoint-port",
      "9292",
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
    throw new Error(
      `model endpoint bootstrap smoke failed with ${result.status}`,
    );
  }

  const report = JSON.parse(result.stdout);
  assert(report.ok === true, "model endpoint bootstrap report was not ok");
  assert(
    report.options.runtimePreset === "local-endpoints",
    "runtime preset option missing",
  );
  assert(
    report.options.modelEndpoint?.port === "9292",
    "model endpoint port option missing",
  );
  assert(
    report.steps.modelBootstrap.ok === true,
    "model bootstrap step did not pass",
  );
  assert(
    report.steps.modelBootstrap.command.includes(
      "--runtime-preset local-endpoints",
    ),
    "model bootstrap command did not include endpoint preset",
  );

  const checklistPath = report.artifacts.modelChecklist;
  assert(checklistPath && existsSync(checklistPath), "model checklist missing");
  const checklist = readFileSync(checklistPath, "utf8");
  assert(
    checklist.includes("Runtime preset: local-endpoints"),
    "checklist did not include endpoint preset",
  );
  assert(
    checklist.includes("http://127.0.0.1:9292/video-frame"),
    "checklist did not include combined video endpoint",
  );

  const readme = readFileSync(join(outputDir, "README.md"), "utf8");
  assert(
    readme.includes("--runtime-preset local-endpoints"),
    "handoff README did not document endpoint bootstrap",
  );
}

function smokeVerifyUiSkip() {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/package-demo-handoff.mjs",
      "--json",
      "--output-dir",
      join(tempDir, "verify-ui-skip"),
      "--skip-prepare",
      "--skip-debug",
      "--skip-real-check",
      "--skip-local-preview",
      "--verify-ui",
      "--skip-verify-ui",
      "--skip-identity-push",
      "--skip-desktop",
      "--skip-model-bootstrap",
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
    throw new Error(`verify UI skip smoke failed with ${result.status}`);
  }

  const report = JSON.parse(result.stdout);
  assert(report.ok === true, "verify UI skip report was not ok");
  assert(report.options.verifyUi === true, "verify UI option was not recorded");
  assert(
    report.steps.fullUiVerify.skipped === true,
    "verify UI step was not skipped",
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
