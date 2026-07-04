import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = process.cwd();
const tempDir = mkdtempSync(join(tmpdir(), "shape-model-bootstrap-smoke-"));

try {
  smokeWindowsReport();
  await smokeVcclientPostReport();
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
  assertEqual(
    report.realModelReadiness.profile,
    "windows-nvidia",
    "windows readiness profile",
  );
  assertReadinessStage(report, "video-processor");
  assertReadinessStage(report, "face");
  assertReadinessStage(report, "background");
  assertReadinessStage(report, "audio-processor");
  assertReadinessStage(report, "voice");
  assertEqual(
    report.demoAssets.frame,
    "C:\\models\\samples\\frame.jpg",
    "windows demo frame",
  );
  assertFileIncludes(checklistPath, "Shape Meet Model Workstation Checklist");
  assertFileIncludes(checklistPath, "FaceFusion");
  assertFileIncludes(checklistPath, "Readiness demo real");
  assertFileIncludes(checklistPath, "Procesador video");
  assertFileIncludes(checklistPath, "C:\\models\\samples\\frame.jpg");
  assertFileIncludes(checklistPath, "--require-real-models");
  assertFileIncludes(checklistPath, "Setup script");
  assertFileIncludes(setupScriptPath, "Shape Meet Windows/NVIDIA");
  assertFileIncludes(setupScriptPath, "git clone --depth 1");
  assertFileIncludes(setupScriptPath, "pnpm models:bootstrap");
  assertHasCheck(report, "runtime", "warn");
  assertHasCheck(report, "checklist", "ok");
  assertHasCheck(report, "setup-script", "ok");
  assertNextStep(report, "--write-runtime");
}

async function smokeVcclientPostReport() {
  let seenPost = false;
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/test") {
      response.writeHead(405, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "post_required" }));
      return;
    }

    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      seenPost = true;
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const audio = Buffer.from(body.buffer, "base64");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          changedVoiceBase64: audio.toString("base64"),
        }),
      );
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  if (!port) throw new Error("vcclient smoke mock did not expose a port");

  try {
    const report = await runBootstrapAsync([
      "--json",
      "--dry-run",
      "--skip-hardware",
      "--profile",
      "windows-nvidia",
      "--vcclient000-http-endpoint",
      `http://127.0.0.1:${port}/test`,
      "--vcclient000-http-mode",
      "w-okada-rest",
    ]);

    assertEqual(seenPost, true, "vcclient POST seen");
    assertEqual(
      report.runtimeEnv.VCCLIENT000_HTTP_MODE,
      "w-okada-rest",
      "vcclient mode",
    );
    assertHasCheck(report, "vcclient000", "ok");
    if (
      !report.checks?.some(
        (check) =>
          check.label === "vcclient000" && check.message.includes("POST /test"),
      )
    ) {
      throw new Error("expected vcclient check to report POST /test");
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
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

function runBootstrapAsync(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["scripts/bootstrap-model-workstation.mjs", ...args],
      {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);
        reject(new Error(`models bootstrap smoke failed with ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);
        reject(error);
      }
    });
  });
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

function assertReadinessStage(report, id) {
  if (!report.realModelReadiness?.stages?.some((stage) => stage.id === id)) {
    throw new Error(`expected real model readiness stage ${id}`);
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
