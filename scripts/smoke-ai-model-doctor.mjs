import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const tempDir = mkdtempSync(join(tmpdir(), "shape-ai-model-doctor-"));
const envPath = join(tempDir, "shape-ai-runtime.env");
const nodeCommand = JSON.stringify(process.execPath);
const copyScript = JSON.stringify(
  join(process.cwd(), "scripts", "copy-processor-io.mjs"),
);

try {
  writeFileSync(
    envPath,
    [
      "SHAPE_AI_MODE=adapter-contract",
      `${line("SHAPE_VIDEO_PROCESSOR_COMMAND", `${nodeCommand} --version`)}`,
      "SHAPE_VIDEO_PROCESSOR_ENDPOINT=http://127.0.0.1:7860/process-frame",
      "SHAPE_VIDEO_PROCESSOR_HEALTH_URL=http://127.0.0.1:7860/health",
      `${line("SHAPE_FACE_COMMAND", `${nodeCommand} ${copyScript} video --input {input} --output {output} --identity {identity}`)}`,
      `${line("SHAPE_BACKGROUND_COMMAND", `${nodeCommand} ${copyScript} video --input {input} --output {output} --clean-plate {clean_plate}`)}`,
      `${line("SHAPE_AUDIO_PROCESSOR_COMMAND", `${nodeCommand} --version`)}`,
      "SHAPE_AUDIO_PROCESSOR_ENDPOINT=http://127.0.0.1:7861/process-audio",
      "SHAPE_AUDIO_PROCESSOR_HEALTH_URL=http://127.0.0.1:7861/health",
      `${line("SHAPE_VOICE_COMMAND", `${nodeCommand} ${copyScript} audio --input {input} --output {output} --sample-rate {sample_rate}`)}`,
      "",
    ].join("\n"),
  );

  const result = spawnSync(
    process.execPath,
    [
      "scripts/check-ai-model-runtime.mjs",
      "--strict",
      "--skip-hardware",
      "--env-file",
      envPath,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    console.error(`models doctor smoke failed with ${result.status}`);
    process.exit(result.status ?? 1);
  }

  const missingEnvPath = join(tempDir, "missing-shape-ai-runtime.env");
  const reportResult = spawnSync(
    process.execPath,
    [
      "scripts/check-ai-model-runtime.mjs",
      "--",
      "--json",
      "--skip-hardware",
      "--profile",
      "windows-nvidia",
      "--env-file",
      missingEnvPath,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );

  if (reportResult.status !== 0) {
    console.error(
      `models doctor next-step smoke failed with ${reportResult.status}`,
    );
    if (reportResult.stdout) process.stdout.write(reportResult.stdout);
    if (reportResult.stderr) process.stderr.write(reportResult.stderr);
    process.exit(reportResult.status ?? 1);
  }

  const report = JSON.parse(reportResult.stdout);
  if (report.profile !== "windows-nvidia") {
    throw new Error("models doctor JSON did not include requested profile");
  }
  if (!report.realModelReadiness) {
    throw new Error("models doctor JSON did not include realModelReadiness");
  }
  if (!report.hardwareReadiness) {
    throw new Error("models doctor JSON did not include hardwareReadiness");
  }
  if (report.hardwareReadiness.status !== "skipped") {
    throw new Error("skip-hardware report should mark hardware as skipped");
  }
  if (report.hardwareReadiness.readyForLocalModels !== false) {
    throw new Error("skip-hardware should not mark local models ready");
  }
  if (report.realModelReadiness.ready !== false) {
    throw new Error("missing runtime env should not be real model ready");
  }
  if (
    !report.realModelReadiness.stages?.some((stage) => stage.id === "face") ||
    !report.realModelReadiness.stages?.some(
      (stage) => stage.id === "background",
    ) ||
    !report.realModelReadiness.stages?.some((stage) => stage.id === "voice")
  ) {
    throw new Error("models doctor JSON did not include model stage readiness");
  }
  if (
    !report.nextSteps?.some((step) =>
      step.includes("pnpm models:runtime -- --profile windows-nvidia"),
    )
  ) {
    throw new Error("models doctor JSON did not include profile next step");
  }

  smokeInprocDoctor();

  console.log("models doctor smoke ok");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

// Inproc mode: with weights on disk, a passing import probe (stubbed python)
// and w-okada + collapsed endpoints configured, the doctor must report
// realModelReadiness.ready=true WITHOUT requiring FACEFUSION_DIR/BMV2_REPO_DIR.
function smokeInprocDoctor() {
  const weightsDir = join(tempDir, "weights");
  mkdirSync(weightsDir, { recursive: true });
  const inswapperPath = join(weightsDir, "inswapper_128.onnx");
  const rvmPath = join(weightsDir, "rvm_mobilenetv3_fp32.torchscript");
  writeFileSync(inswapperPath, "stub-weight");
  writeFileSync(rvmPath, "stub-weight");

  const insightfaceHome = join(tempDir, "insightface");
  mkdirSync(join(insightfaceHome, "models", "buffalo_l"), { recursive: true });

  const probeJson = JSON.stringify({
    modules: {
      numpy: true,
      cv2: true,
      onnxruntime: true,
      insightface: true,
      torch: true,
    },
    providers: ["CPUExecutionProvider"],
  });
  const isWindows = process.platform === "win32";
  const stubPython = join(
    tempDir,
    isWindows ? "python-stub.cmd" : "python-stub.sh",
  );
  writeFileSync(
    stubPython,
    isWindows
      ? `@echo ${probeJson.replace(/"/g, '\\"')}\r\n`
      : `#!/bin/sh\necho '${probeJson}'\n`,
  );
  if (!isWindows) chmodSync(stubPython, 0o755);

  const inprocEnvPath = join(tempDir, "shape-ai-runtime-inproc.env");
  writeFileSync(
    inprocEnvPath,
    [
      "SHAPE_AI_MODE=adapter-contract",
      "SHAPE_MODEL_ENDPOINT_ENGINE=inproc",
      "SHAPE_MODEL_ENDPOINT_HOST=127.0.0.1",
      "SHAPE_MODEL_ENDPOINT_PORT=9100",
      "SHAPE_VIDEO_PROCESSOR_ENDPOINT=http://127.0.0.1:9100/process-frame",
      "SHAPE_VIDEO_PROCESSOR_HEALTH_URL=http://127.0.0.1:9100/health",
      "SHAPE_AUDIO_PROCESSOR_ENDPOINT=http://127.0.0.1:9100/process-audio",
      "SHAPE_AUDIO_PROCESSOR_HEALTH_URL=http://127.0.0.1:9100/health",
      "SHAPE_BACKGROUND_ENGINE=rvm",
      `SHAPE_MODEL_ENDPOINT_PYTHON=${stubPython}`,
      `SHAPE_INSWAPPER_MODEL=${inswapperPath}`,
      `SHAPE_RVM_MODEL=${rvmPath}`,
      `INSIGHTFACE_HOME=${insightfaceHome}`,
      "VCCLIENT000_HTTP_ENDPOINT=http://127.0.0.1:18888/test",
      "VCCLIENT000_HTTP_MODE=w-okada-rest",
      "",
    ].join("\n"),
  );

  const result = spawnSync(
    process.execPath,
    [
      "scripts/check-ai-model-runtime.mjs",
      "--",
      "--json",
      "--skip-hardware",
      "--profile",
      "apple-silicon",
      "--env-file",
      inprocEnvPath,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );

  if (result.status !== 0) {
    console.error(`models doctor inproc smoke failed with ${result.status}`);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }

  const report = JSON.parse(result.stdout);
  if (report.engine !== "inproc") {
    throw new Error("inproc doctor did not detect SHAPE_MODEL_ENDPOINT_ENGINE");
  }
  const readiness = report.realModelReadiness;
  if (readiness?.engine !== "inproc") {
    throw new Error("inproc readiness did not report engine inproc");
  }
  if (readiness.ready !== true) {
    throw new Error(
      `inproc readiness should be ready with weights + probe + no passthrough: ${JSON.stringify(readiness, null, 2)}`,
    );
  }
  if (report.inprocProbe?.ok !== true) {
    throw new Error("inproc import probe did not pass with the stub python");
  }
  if (!report.inprocProbe.providers.includes("CPUExecutionProvider")) {
    throw new Error("inproc probe did not report providers");
  }
  for (const id of [
    "video-processor",
    "face",
    "background",
    "audio-processor",
    "voice",
  ]) {
    const stage = readiness.stages?.find((entry) => entry.id === id);
    if (!stage || stage.status !== "ready") {
      throw new Error(
        `inproc stage ${id} should be ready, got ${stage?.status}`,
      );
    }
  }
  if (
    report.issues?.some((message) =>
      /FACEFUSION_DIR|BMV2_REPO_DIR|inference_images/.test(message),
    )
  ) {
    throw new Error("inproc doctor must not require the CLI wrapper repos");
  }

  // Missing weights must block readiness (weights are mandatory in inproc).
  const brokenEnvPath = join(tempDir, "shape-ai-runtime-inproc-broken.env");
  writeFileSync(
    brokenEnvPath,
    [
      "SHAPE_MODEL_ENDPOINT_ENGINE=inproc",
      "SHAPE_VIDEO_PROCESSOR_ENDPOINT=http://127.0.0.1:9100/process-frame",
      "SHAPE_AUDIO_PROCESSOR_ENDPOINT=http://127.0.0.1:9100/process-audio",
      `SHAPE_MODEL_ENDPOINT_PYTHON=${stubPython}`,
      "VCCLIENT000_HTTP_ENDPOINT=http://127.0.0.1:18888/test",
      "",
    ].join("\n"),
  );
  const brokenResult = spawnSync(
    process.execPath,
    [
      "scripts/check-ai-model-runtime.mjs",
      "--",
      "--json",
      "--skip-hardware",
      "--profile",
      "apple-silicon",
      "--env-file",
      brokenEnvPath,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  const brokenReport = JSON.parse(brokenResult.stdout);
  if (brokenReport.realModelReadiness?.ready !== false) {
    throw new Error("inproc readiness must be blocked without weights");
  }
  if (brokenResult.status === 0) {
    throw new Error("inproc doctor should exit non-zero when weights missing");
  }
}

function line(key, value) {
  return `${key}=${value}`;
}
