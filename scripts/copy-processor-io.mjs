import { copyFileSync } from "node:fs";

const kind = process.argv[2] ?? process.env.SHAPE_PROCESSOR_KIND ?? "video";

if (process.env.SHAPE_COPY_REQUIRE_CONTEXT === "1") {
  requireContext(kind);
}

if (kind === "audio") {
  copyPath(process.env.SHAPE_AUDIO_INPUT_PATH, process.env.SHAPE_AUDIO_OUTPUT_PATH);
} else {
  copyPath(process.env.SHAPE_FRAME_INPUT_PATH, process.env.SHAPE_FRAME_OUTPUT_PATH);
}

function copyPath(input, output) {
  if (!input || !output) {
    console.error("Missing processor input/output path.");
    process.exit(1);
  }

  copyFileSync(input, output);
}

function requireContext(kind) {
  const required = [
    "SHAPE_PROCESSOR_KIND",
    "SHAPE_MODEL_STAGE",
    "SHAPE_SESSION_ID",
    "SHAPE_REQUEST_SEQUENCE",
  ];

  if (kind === "audio") {
    required.push("SHAPE_AUDIO_SEQUENCE");
  } else {
    required.push("SHAPE_FRAME_SEQUENCE");
  }

  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(`Missing processor context env: ${missing.join(", ")}`);
    process.exit(2);
  }

  if (process.env.SHAPE_PROCESSOR_KIND !== kind) {
    console.error(
      `Unexpected SHAPE_PROCESSOR_KIND=${process.env.SHAPE_PROCESSOR_KIND}; expected ${kind}.`,
    );
    process.exit(2);
  }
}
