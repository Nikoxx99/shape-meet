#!/usr/bin/env python3
import argparse
import os
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
    parser = argparse.ArgumentParser(description="Shape Meet FaceFusion frame wrapper")
    parser.add_argument("--input", default=env_value("SHAPE_FRAME_INPUT_PATH"), required=False)
    parser.add_argument("--output", default=env_value("SHAPE_FRAME_OUTPUT_PATH"), required=False)
    parser.add_argument("--identity", default=env_value("SHAPE_IDENTITY_PATH") or env_value("SHAPE_IDENTITY_URI"), required=False)
    parser.add_argument("--facefusion-dir", default=env_value("FACEFUSION_DIR"))
    parser.add_argument("--entrypoint", default=env_value("FACEFUSION_ENTRYPOINT", "facefusion.py"))
    parser.add_argument("--python", default=env_value("FACEFUSION_PYTHON", "python"))
    parser.add_argument("--processors", default=env_value("FACEFUSION_PROCESSORS", "face_swapper face_enhancer"))
    parser.add_argument("--execution-providers", default=env_value("FACEFUSION_EXECUTION_PROVIDERS", "cuda"))
    parser.add_argument("--extra-args", default=env_value("FACEFUSION_EXTRA_ARGS", ""))
    parser.add_argument("--command-template", default=env_value("FACEFUSION_COMMAND_TEMPLATE"))
    parser.add_argument("--timeout", type=float, default=env_float("FACEFUSION_TIMEOUT_SECS", "30", minimum=0.1))
    parser.add_argument("--passthrough-if-unavailable", action="store_true", default=env_flag("SHAPE_WRAPPER_PASSTHROUGH", False))
    args = parser.parse_args()

    input_path = ensure_file(args.input, "frame input")
    if not args.output:
        fail("frame output no configurado.")

    identity_path = Path(args.identity) if args.identity else None
    if not identity_path or not identity_path.exists():
        if args.passthrough_if_unavailable:
            raise SystemExit(copy_passthrough(input_path, args.output, "identidad FaceFusion no disponible"))
        fail("FaceFusion requiere una identidad local. Revisa identityLocalArtifactPath/cache.")

    if args.command_template:
        command = template_args(
            args.command_template,
            {
                "input": str(input_path),
                "output": args.output,
                "identity": str(identity_path),
                "width": env_value("SHAPE_TARGET_WIDTH", ""),
                "height": env_value("SHAPE_TARGET_HEIGHT", ""),
                "fps": env_value("SHAPE_TARGET_FPS", ""),
                "session_id": env_value("SHAPE_SESSION_ID", ""),
            },
        )
        run_checked(command, timeout=args.timeout)
        assert_output(args.output)
        return

    facefusion_dir = Path(args.facefusion_dir) if args.facefusion_dir else None
    entrypoint = Path(args.entrypoint)
    if facefusion_dir and not entrypoint.is_absolute():
        entrypoint = facefusion_dir / entrypoint

    if not entrypoint.exists():
        if args.passthrough_if_unavailable:
            raise SystemExit(copy_passthrough(input_path, args.output, "FaceFusion no instalado"))
        fail("FACEFUSION_DIR o FACEFUSION_ENTRYPOINT no apuntan a facefusion.py.")

    command = [
        args.python,
        str(entrypoint),
        "headless-run",
        "--source-paths",
        str(identity_path),
        "--target-path",
        str(input_path),
        "--output-path",
        args.output,
    ]

    processors = split_args(args.processors)
    if processors:
        command.extend(["--processors", *processors])

    providers = split_args(args.execution_providers)
    if providers:
        command.extend(["--execution-providers", *providers])

    command.extend(split_args(args.extra_args))
    run_checked(command, cwd=str(facefusion_dir) if facefusion_dir else None, timeout=args.timeout)
    assert_output(args.output)


if __name__ == "__main__":
    main()
