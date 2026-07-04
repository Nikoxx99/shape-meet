import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = process.cwd();
const tempDir = mkdtempSync(join(tmpdir(), "shape-model-bootstrap-smoke-"));

try {
  smokeWindowsReport();
  smokeAppleWorkspaceReport();
  console.log("model workstation bootstrap smoke ok");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

function smokeWindowsReport() {
  const checklistPath = join(tempDir, "windows-checklist.md");
  const setupScriptPath = join(tempDir, "setup-windows.ps1");
  const report = runBootstrap([
    "--json",
    "--dry-run",
    "--write-checklist",
    "--checklist-out",
    checklistPath,
    "--write-setup-script",
    "--setup-script-out",
    setupScriptPath,
    "--skip-hardware",
    "--skip-vcclient",
    "--profile",
    "windows-nvidia",
  ]);

  assertEqual(report.profile, "windows-nvidia", "windows profile");
  assertEqual(report.runtimeWritten, false, "windows runtimeWritten");
  assertEqual(
    report.runtimeEnv.SHAPE_MODEL_WORKSTATION_PROFILE,
    "windows-nvidia",
    "windows runtime profile",
  );
  assertEqual(
    report.runtimeEnv.FACEFUSION_DIR,
    "C:\\models\\FaceFusion",
    "windows FaceFusion dir",
  );
  assertEqual(
    report.runtimeEnv.BMV2_MODEL_CHECKPOINT,
    "C:\\models\\BackgroundMattingV2\\pytorch_resnet50.pth",
    "windows BMV2 checkpoint",
  );
  assertEqual(report.checklistWritten, true, "windows checklistWritten");
  assertEqual(report.setupScriptWritten, true, "windows setupScriptWritten");
  assertFileIncludes(checklistPath, "Shape Meet Model Workstation Checklist");
  assertFileIncludes(checklistPath, "FaceFusion");
  assertFileIncludes(checklistPath, "Setup script");
  assertFileIncludes(setupScriptPath, "Shape Meet Windows/NVIDIA");
  assertFileIncludes(setupScriptPath, "git clone --depth 1");
  assertFileIncludes(setupScriptPath, "pnpm models:bootstrap");
  assertHasCheck(report, "runtime", "warn");
  assertHasCheck(report, "checklist", "ok");
  assertHasCheck(report, "setup-script", "ok");
  assertNextStep(report, "--write-runtime");
}

function smokeAppleWorkspaceReport() {
  const workspace = join(tempDir, "models");
  const facefusionDir = join(workspace, "FaceFusion");
  const bmv2Dir = join(workspace, "BackgroundMattingV2");
  const facefusionPython = join(facefusionDir, ".venv", "bin", "python");
  const bmv2Python = join(bmv2Dir, ".venv", "bin", "python");
  const checkpoint = join(bmv2Dir, "pytorch_resnet50.pth");

  mkdirSync(join(facefusionDir, ".venv", "bin"), { recursive: true });
  mkdirSync(join(bmv2Dir, ".venv", "bin"), { recursive: true });
  writeFileSync(join(facefusionDir, "facefusion.py"), "# smoke\n");
  writeFileSync(join(bmv2Dir, "inference_images.py"), "# smoke\n");
  writeFileSync(facefusionPython, "#!/bin/sh\nexit 0\n");
  writeFileSync(bmv2Python, "#!/bin/sh\nexit 0\n");
  writeFileSync(checkpoint, "checkpoint\n");
  chmodSync(facefusionPython, 0o755);
  chmodSync(bmv2Python, 0o755);

  const report = runBootstrap([
    "--json",
    "--dry-run",
    "--skip-hardware",
    "--skip-vcclient",
    "--profile",
    "apple-silicon",
    "--workspace",
    workspace,
  ]);

  assertEqual(report.profile, "apple-silicon", "apple profile");
  assertEqual(
    report.modelPaths.facefusionDir,
    facefusionDir,
    "apple FaceFusion dir",
  );
  assertEqual(report.modelPaths.bmv2RepoDir, bmv2Dir, "apple BMV2 dir");
  assertHasCheck(report, "FaceFusion", "ok");
  assertHasCheck(report, "BackgroundMattingV2", "ok");
  assertNoCheck(report, "FaceFusion", "error");
  assertNoCheck(report, "BackgroundMattingV2", "error");
}

function runBootstrap(args) {
  const result = spawnSync(
    process.execPath,
    ["scripts/bootstrap-model-workstation.mjs", ...args],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );

  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`models bootstrap smoke failed with ${result.status}`);
  }

  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw error;
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function assertHasCheck(report, label, status) {
  if (
    !report.checks?.some(
      (check) => check.label === label && check.status === status,
    )
  ) {
    throw new Error(`expected ${status} check for ${label}`);
  }
}

function assertNoCheck(report, label, status) {
  if (
    report.checks?.some(
      (check) => check.label === label && check.status === status,
    )
  ) {
    throw new Error(`unexpected ${status} check for ${label}`);
  }
}

function assertNextStep(report, value) {
  if (!report.nextSteps?.some((step) => step.includes(value))) {
    throw new Error(`expected next step containing ${value}`);
  }
}

function assertFileIncludes(filePath, value) {
  if (!existsSync(filePath)) {
    throw new Error(`expected file to exist: ${filePath}`);
  }
  const content = readFileSync(filePath, "utf8");
  if (!content.includes(value)) {
    throw new Error(`expected ${filePath} to include ${value}`);
  }
}
