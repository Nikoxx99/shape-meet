#!/usr/bin/env python3
import argparse
import os
import shutil
import tempfile
from pathlib import Path

from shape_wrapper_common import (
    assert_output,
    copy_passthrough,
    ensure_file,
    env_flag,
    env_float,
    env_value,
    fail,
    run_checked,
    split_args,
    template_args,
)


def main():
    parser = argparse.ArgumentParser(description="Shape Meet BackgroundMattingV2 frame wrapper")
    parser.add_argument("--input", default=env_value("SHAPE_FRAME_INPUT_PATH"), required=False)
    parser.add_argument("--output", default=env_value("SHAPE_FRAME_OUTPUT_PATH"), required=False)
    parser.add_argument("--clean-plate", default=env_value("SHAPE_CLEAN_PLATE_PATH"), required=False)
    parser.add_argument("--repo-dir", default=env_value("BMV2_REPO_DIR"))
    parser.add_argument("--python", default=env_value("BMV2_PYTHON", "python"))
    parser.add_argument("--checkpoint", default=env_value("BMV2_MODEL_CHECKPOINT"))
    parser.add_argument("--model-type", default=env_value("BMV2_MODEL_TYPE", "mattingrefine"))
    parser.add_argument("--model-backbone", default=env_value("BMV2_MODEL_BACKBONE", "resnet50"))
    parser.add_argument("--model-backbone-scale", default=env_value("BMV2_MODEL_BACKBONE_SCALE", "0.25"))
    parser.add_argument("--model-refine-mode", default=env_value("BMV2_MODEL_REFINE_MODE", "sampling"))
    parser.add_argument("--model-refine-sample-pixels", default=env_value("BMV2_MODEL_REFINE_SAMPLE_PIXELS", "80000"))
    parser.add_argument("--device", default=env_value("BMV2_DEVICE", "cuda"))
    parser.add_argument("--extra-args", default=env_value("BMV2_EXTRA_ARGS", ""))
    parser.add_argument("--command-template", default=env_value("BMV2_COMMAND_TEMPLATE"))
    parser.add_argument("--timeout", type=float, default=env_float("BMV2_TIMEOUT_SECS", "30", minimum=0.1))
    parser.add_argument("--passthrough-if-unavailable", action="store_true", default=env_flag("SHAPE_WRAPPER_PASSTHROUGH", False))
    args = parser.parse_args()

    input_path = ensure_file(args.input, "frame input")
    if not args.output:
        fail("frame output no configurado.")

    clean_plate = Path(args.clean_plate) if args.clean_plate else None
    if not clean_plate or not clean_plate.exists():
        if args.passthrough_if_unavailable:
            raise SystemExit(copy_passthrough(input_path, args.output, "clean plate no disponible"))
        fail("BackgroundMattingV2 requiere clean plate local.")

    if args.command_template:
        command = template_args(
            args.command_template,
            {
                "input": str(input_path),
                "output": args.output,
                "clean_plate": str(clean_plate),
                "width": env_value("SHAPE_TARGET_WIDTH", ""),
                "height": env_value("SHAPE_TARGET_HEIGHT", ""),
                "fps": env_value("SHAPE_TARGET_FPS", ""),
                "session_id": env_value("SHAPE_SESSION_ID", ""),
            },
        )
        run_checked(command, timeout=args.timeout)
        assert_output(args.output)
        return

    repo_dir = Path(args.repo_dir) if args.repo_dir else None
    if not repo_dir or not (repo_dir / "inference_images.py").exists():
        if args.passthrough_if_unavailable:
            raise SystemExit(copy_passthrough(input_path, args.output, "BackgroundMattingV2 no instalado"))
        fail("BMV2_REPO_DIR debe apuntar al repo BackgroundMattingV2.")

    if not args.checkpoint or not Path(args.checkpoint).exists():
        if args.passthrough_if_unavailable:
            raise SystemExit(copy_passthrough(input_path, args.output, "checkpoint BackgroundMattingV2 no disponible"))
        fail("BMV2_MODEL_CHECKPOINT no existe.")

    with tempfile.TemporaryDirectory(prefix="shape-bmv2-") as workdir:
        workdir_path = Path(workdir)
        src_dir = workdir_path / "src"
        bgr_dir = workdir_path / "bgr"
        output_dir = workdir_path / "out"
        src_dir.mkdir()
        bgr_dir.mkdir()
        shutil.copyfile(input_path, src_dir / "frame.jpg")
        shutil.copyfile(clean_plate, bgr_dir / "frame.jpg")

        command = [
            args.python,
            str(repo_dir / "inference_images.py"),
            "--model-type",
            args.model_type,
            "--model-backbone",
            args.model_backbone,
            "--model-backbone-scale",
            args.model_backbone_scale,
            "--model-checkpoint",
            args.checkpoint,
            "--model-refine-mode",
            args.model_refine_mode,
            "--model-refine-sample-pixels",
            args.model_refine_sample_pixels,
            "--images-src",
            str(src_dir),
            "--images-bgr",
            str(bgr_dir),
            "--output-dir",
            str(output_dir),
            "--output-types",
            "com",
            "--device",
            args.device,
            "-y",
        ]
        command.extend(split_args(args.extra_args))
        run_checked(command, cwd=str(repo_dir), timeout=args.timeout)

        composed = output_dir / "com" / "frame.png"
        assert_output(composed)
        shutil.copyfile(composed, args.output)
        assert_output(args.output)


if __name__ == "__main__":
    main()
