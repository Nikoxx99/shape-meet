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
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = process.cwd();
const tempDir = mkdtempSync(join(tmpdir(), "shape-model-bootstrap-smoke-"));

try {
  smokeWindowsReport();
  smokeEndpointRuntimeReport();
  await smokeVcclientPostReport();
  smokeAppleWorkspaceReport();
  smokeAppleDefaultSetupScript();
  smokeInprocReport();
  smokeInprocV1SetupScript();
  smokeDemoAssetsWrite();
  console.log("model workstation bootstrap smoke ok");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

// --engine inproc: runtime env colapsado (endpoints directos, sin
// *_PROCESSOR_COMMAND), pesos in-process y setup script con descarga RVM
// verificada + warm-up buffalo_l + probe w-okada + doctor final.
function smokeInprocReport() {
  const setupScriptPath = join(tempDir, "setup-inproc.sh");
  const checklistPath = join(tempDir, "inproc-checklist.md");
  const weightsDir = join(tempDir, "inproc-weights");
  mkdirSync(weightsDir, { recursive: true });
  writeFileSync(join(weightsDir, "inswapper_128.onnx"), "stub-weight");
  writeFileSync(
    join(weightsDir, "rvm_mobilenetv3_fp32.torchscript"),
    "stub-weight",
  );

  const report = runBootstrap([
    "--json",
    "--dry-run",
    "--skip-hardware",
    "--skip-vcclient",
    "--profile",
    "apple-silicon",
    "--engine",
    "inproc",
    "--weights-dir",
    weightsDir,
    "--model-endpoint-host",
    "127.0.0.1",
    "--model-endpoint-port",
    "9100",
    "--write-setup-script",
    "--setup-script-out",
    setupScriptPath,
    "--write-checklist",
    "--checklist-out",
    checklistPath,
  ]);

  assertEqual(report.engine, "inproc", "inproc engine");
  assertEqual(report.runtimePreset, "local-endpoints", "inproc preset");
  assertEqual(
    report.runtimeEnv.SHAPE_MODEL_ENDPOINT_ENGINE,
    "inproc",
    "inproc runtime engine",
  );
  assertEqual(
    report.runtimeEnv.SHAPE_VIDEO_PROCESSOR_ENDPOINT,
    "http://127.0.0.1:9100/process-frame",
    "inproc collapsed video endpoint",
  );
  assertEqual(
    report.runtimeEnv.SHAPE_AUDIO_PROCESSOR_ENDPOINT,
    "http://127.0.0.1:9100/process-audio",
    "inproc collapsed audio endpoint",
  );
  assertEqual(
    report.runtimeEnv.SHAPE_VIDEO_PROCESSOR_COMMAND,
    undefined,
    "inproc must not define a video command (collapsed hops)",
  );
  assertEqual(
    report.runtimeEnv.SHAPE_AUDIO_PROCESSOR_COMMAND,
    undefined,
    "inproc must not define an audio command (collapsed hops)",
  );
  assertEqual(
    report.runtimeEnv.SHAPE_FACE_EXECUTION_PROVIDERS,
    "coreml,cpu",
    "inproc apple providers",
  );
  assertEqual(
    report.runtimeEnv.SHAPE_BACKGROUND_ENGINE,
    "rvm",
    "inproc background engine",
  );
  assertEqual(
    report.runtimeEnv.SHAPE_PROCESSOR_TIMEOUT_SECS,
    "4.0",
    "inproc phase-1 processor timeout",
  );
  assertEqual(
    report.runtimeEnv.SHAPE_AUDIO_PROCESSOR_TIMEOUT_SECS,
    "2.5",
    "inproc phase-1 audio timeout",
  );
  assertEqual(
    report.runtimeEnv.SHAPE_MODEL_ENDPOINT_TIMEOUT_SECS,
    "3.0",
    "inproc phase-1 endpoint timeout",
  );
  assertEqual(
    report.runtimeEnv.SHAPE_MODEL_ENDPOINT_LOAD_TIMEOUT_SECS,
    "60",
    "inproc phase-1 load timeout",
  );
  assertEqual(
    report.runtimeEnv.SHAPE_INSWAPPER_MODEL,
    join(weightsDir, "inswapper_128.onnx"),
    "inproc inswapper path",
  );
  assertEqual(
    report.runtimeEnv.SHAPE_RVM_MODEL,
    join(weightsDir, "rvm_mobilenetv3_fp32.torchscript"),
    "inproc rvm path",
  );
  assertEqual(
    report.runtimeEnv.VCCLIENT000_HTTP_ENDPOINT,
    "http://127.0.0.1:18000",
    "inproc default VCClient v2 endpoint",
  );
  assertEqual(
    report.runtimeEnv.VCCLIENT000_HTTP_MODE,
    "auto",
    "inproc default VCClient http mode",
  );
  assertHasCheck(report, "pesos", "ok");
  assertNoCheck(report, "FaceFusion", "error");
  assertNoCheck(report, "BackgroundMattingV2", "error");

  assertFileIncludes(setupScriptPath, "requirements-inproc-mac.txt");
  assertFileIncludes(
    setupScriptPath,
    "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.torchscript",
  );
  assertFileIncludes(
    setupScriptPath,
    "f01e0c9338b9a6a31b881ea6d4360d70c1e549701b3792e14c9ed88d6196c5a1",
  );
  assertFileIncludes(setupScriptPath, "buffalo_l");
  assertFileIncludes(setupScriptPath, "inswapper_128.onnx");
  // Default endpoint has no explicit /test path -> the generated probe uses
  // the VCClient v2 health check, not the legacy v1 POST /test contract.
  assertFileIncludes(setupScriptPath, "Probe VCClient v2 (GET /api/hello)");
  assertFileIncludes(setupScriptPath, "/api/voice-changer/convert_chunk");
  assertFileExcludes(setupScriptPath, "changedVoiceBase64");
  assertFileIncludes(setupScriptPath, "pnpm models:doctor");
  assertFileExcludes(setupScriptPath, "git clone");

  assertFileIncludes(checklistPath, "Engine: inproc");
  assertFileIncludes(checklistPath, "--engine inproc");
  assertFileIncludes(checklistPath, "Endpoint video (colapsado)");
}

// Explicit v1 (legacy w-okada) endpoint: an endpoint whose path is /test must
// still generate the legacy POST /test probe, not the v2 health check.
function smokeInprocV1SetupScript() {
  const setupScriptPath = join(tempDir, "setup-inproc-v1.sh");
  const weightsDir = join(tempDir, "inproc-v1-weights");
  mkdirSync(weightsDir, { recursive: true });
  writeFileSync(join(weightsDir, "inswapper_128.onnx"), "stub-weight");
  writeFileSync(
    join(weightsDir, "rvm_mobilenetv3_fp32.torchscript"),
    "stub-weight",
  );

  const report = runBootstrap([
    "--json",
    "--dry-run",
    "--skip-hardware",
    "--skip-vcclient",
    "--profile",
    "apple-silicon",
    "--engine",
    "inproc",
    "--weights-dir",
    weightsDir,
    "--vcclient000-http-endpoint",
    "http://127.0.0.1:18888/test",
    "--write-setup-script",
    "--setup-script-out",
    setupScriptPath,
  ]);

  assertEqual(
    report.runtimeEnv.VCCLIENT000_HTTP_ENDPOINT,
    "http://127.0.0.1:18888/test",
    "explicit v1 endpoint preserved",
  );
  assertEqual(
    report.runtimeEnv.VCCLIENT000_HTTP_MODE,
    "auto",
    "explicit v1 endpoint still defaults http mode to auto",
  );
  assertFileIncludes(setupScriptPath, "Probe VCClient v1 (POST /test)");
  assertFileIncludes(setupScriptPath, "changedVoiceBase64");
  assertFileExcludes(setupScriptPath, "Probe VCClient v2 (GET /api/hello)");
  assertFileExcludes(setupScriptPath, "/api/voice-changer/convert_chunk");
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
  assertFileIncludes(setupScriptPath, "--runtime-preset local-wrappers");
  assertFileIncludes(setupScriptPath, "$RuntimeEnvPath");
  assertFileIncludes(setupScriptPath, "pnpm models:preflight");
  assertFileIncludes(setupScriptPath, "C:\\models\\identities\\host.jpg");
  assertFileIncludes(setupScriptPath, "C:\\models\\samples\\clean-plate.jpg");
  assertFileIncludes(setupScriptPath, "--require-real-models");
  assertHasCheck(report, "runtime", "warn");
  assertHasCheck(report, "checklist", "ok");
  assertHasCheck(report, "setup-script", "ok");
  assertNextStep(report, "--write-runtime");
}

function smokeEndpointRuntimeReport() {
  const checklistPath = join(tempDir, "endpoint-checklist.md");
  const setupScriptPath = join(tempDir, "endpoint-setup.ps1");
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
    "--runtime-preset",
    "local-endpoints",
    "--model-endpoint-host",
    "127.0.0.1",
    "--model-endpoint-port",
    "9191",
  ]);

  assertEqual(
    report.runtimePreset,
    "local-endpoints",
    "endpoint runtimePreset",
  );
  assertEqual(
    report.runtimeEnv.SHAPE_MODEL_RUNTIME_PRESET,
    "local-endpoints",
    "endpoint runtime env preset",
  );
  assertEqual(
    report.runtimeEnv.SHAPE_MODEL_ENDPOINT_HOST,
    "127.0.0.1",
    "endpoint host",
  );
  assertEqual(
    report.runtimeEnv.SHAPE_MODEL_ENDPOINT_PORT,
    "9191",
    "endpoint port",
  );
  assertEqual(
    report.runtimeEnv.SHAPE_VIDEO_FRAME_ENDPOINT,
    "http://127.0.0.1:9191/video-frame",
    "combined video endpoint",
  );
  assertEqual(
    report.runtimeEnv.SHAPE_FACE_ENDPOINT,
    "http://127.0.0.1:9191/face",
    "face endpoint",
  );
  assertEqual(
    report.runtimeEnv.SHAPE_BACKGROUND_ENDPOINT,
    "http://127.0.0.1:9191/background",
    "background endpoint",
  );
  assertEqual(
    report.runtimeEnv.SHAPE_VOICE_ENDPOINT,
    "http://127.0.0.1:9191/voice",
    "voice endpoint",
  );
  assertFileIncludes(checklistPath, "Runtime preset: local-endpoints");
  assertFileIncludes(checklistPath, "Endpoint video combinado");
  assertFileIncludes(checklistPath, "http://127.0.0.1:9191/video-frame");
  assertFileIncludes(checklistPath, "--runtime-preset local-endpoints");
  assertFileIncludes(checklistPath, "--model-endpoint-port 9191");
  assertFileIncludes(setupScriptPath, "--runtime-preset local-endpoints");
  assertFileIncludes(setupScriptPath, "--model-endpoint-host 127.0.0.1");
  assertFileIncludes(setupScriptPath, "--model-endpoint-port 9191");
  assertFileIncludes(
    setupScriptPath,
    "--video-frame-endpoint http://127.0.0.1:9191/video-frame",
  );
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

function smokeAppleDefaultSetupScript() {
  const setupScriptPath = join(tempDir, "setup-apple-default.sh");
  const report = runBootstrap([
    "--json",
    "--dry-run",
    "--skip-vcclient",
    "--profile",
    "apple-silicon",
    "--write-setup-script",
    "--setup-script-out",
    setupScriptPath,
  ]);

  assertEqual(report.setupScriptWritten, true, "apple setupScriptWritten");
  assertFileIncludes(setupScriptPath, `WORKSPACE='${homedir()}/models'`);
  assertFileIncludes(
    setupScriptPath,
    `FACEFUSION_DIR='${homedir()}/models/FaceFusion'`,
  );
  assertFileExcludes(setupScriptPath, "WORKSPACE='~/models'");
}

function smokeDemoAssetsWrite() {
  const workspace = join(tempDir, "asset-workspace");
  const report = runBootstrap([
    "--json",
    "--skip-hardware",
    "--skip-vcclient",
    "--profile",
    "apple-silicon",
    "--workspace",
    workspace,
    "--write-demo-assets",
  ]);

  assertEqual(report.demoAssetsWritten, true, "demoAssetsWritten");
  assertFileNonEmpty(report.demoAssets.frame, "demo frame");
  assertFileNonEmpty(report.demoAssets.identity, "demo identity");
  assertFileNonEmpty(report.demoAssets.cleanPlate, "demo clean plate");
  assertFileNonEmpty(report.demoAssets.audio, "demo audio");
  assertHasCheck(report, "asset-frame", "ok");
  assertHasCheck(report, "asset-identity", "ok");
  assertNextStep(report, "identities/host.jpg");
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

function assertFileExcludes(filePath, value) {
  if (!existsSync(filePath)) {
    throw new Error(`expected file to exist: ${filePath}`);
  }
  const content = readFileSync(filePath, "utf8");
  if (content.includes(value)) {
    throw new Error(`expected ${filePath} not to include ${value}`);
  }
}

function assertFileNonEmpty(filePath, label) {
  if (!existsSync(filePath)) {
    throw new Error(`expected ${label} to exist: ${filePath}`);
  }
  const content = readFileSync(filePath);
  if (content.byteLength <= 0) {
    throw new Error(`expected ${label} to be non-empty: ${filePath}`);
  }
}
