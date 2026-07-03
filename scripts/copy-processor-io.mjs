import { copyFileSync } from "node:fs";

const kind = process.argv[2] ?? process.env.SHAPE_PROCESSOR_KIND ?? "video";

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
