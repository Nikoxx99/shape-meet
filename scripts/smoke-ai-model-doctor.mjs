import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  console.log("models doctor smoke ok");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

function line(key, value) {
  return `${key}=${value}`;
}
