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

  console.log("models doctor smoke ok");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

function line(key, value) {
  return `${key}=${value}`;
}
