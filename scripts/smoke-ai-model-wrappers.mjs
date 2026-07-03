import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const python =
  process.env.SHAPE_AI_SMOKE_PYTHON ?? process.env.SHAPE_AI_PYTHON ?? "python3";
const tempDir = mkdtempSync(join(tmpdir(), "shape-model-wrappers-"));

try {
  const inputFrame = join(tempDir, "frame.jpg");
  const identity = join(tempDir, "identity.jpg");
  const cleanPlate = join(tempDir, "clean.jpg");
  const inputAudio = join(tempDir, "audio.f32le");
  writeFileSync(inputFrame, tinyJpeg());
  writeFileSync(identity, tinyJpeg());
  writeFileSync(cleanPlate, tinyJpeg());
  writeFileSync(inputAudio, Buffer.alloc(480 * 4));

  smokeWrapper("facefusion", [
    "apps/ai-sidecar/wrappers/facefusion_frame.py",
    "--input",
    inputFrame,
    "--output",
    join(tempDir, "face.out.jpg"),
    "--identity",
    identity,
  ]);
  smokeWrapper("backgroundmattingv2", [
    "apps/ai-sidecar/wrappers/backgroundmattingv2_frame.py",
    "--input",
    inputFrame,
    "--output",
    join(tempDir, "background.out.jpg"),
    "--clean-plate",
    cleanPlate,
  ]);
  smokeWrapper("vcclient000", [
    "apps/ai-sidecar/wrappers/vcclient000_chunk.py",
    "--input",
    inputAudio,
    "--output",
    join(tempDir, "voice.out.f32le"),
    "--sample-rate",
    "48000",
    "--channels",
    "1",
    "--format",
    "pcm_f32le",
  ]);

  console.log("model wrappers smoke ok");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

function smokeWrapper(label, args) {
  const result = spawnSync(python, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      SHAPE_WRAPPER_PASSTHROUGH: "true",
    },
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    fail(`${label} wrapper failed with ${result.status}`);
  }

  const output = args[args.indexOf("--output") + 1];
  const bytes = readFileSync(output);
  if (bytes.byteLength <= 0) fail(`${label} wrapper output is empty`);
}

function tinyJpeg() {
  return Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Al//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z",
    "base64",
  );
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
