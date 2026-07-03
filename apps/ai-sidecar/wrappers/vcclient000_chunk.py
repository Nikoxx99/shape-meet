#!/usr/bin/env python3
import argparse
import base64
import json
import urllib.error
import urllib.request
from pathlib import Path

from shape_wrapper_common import (
    assert_output,
    copy_passthrough,
    ensure_file,
    env_flag,
    env_value,
    fail,
    run_checked,
    template_args,
)


def main():
    parser = argparse.ArgumentParser(description="Shape Meet vcclient000 audio chunk wrapper")
    parser.add_argument("--input", default=env_value("SHAPE_AUDIO_INPUT_PATH"), required=False)
    parser.add_argument("--output", default=env_value("SHAPE_AUDIO_OUTPUT_PATH"), required=False)
    parser.add_argument("--sample-rate", default=env_value("SHAPE_AUDIO_SAMPLE_RATE", "48000"))
    parser.add_argument("--channels", default=env_value("SHAPE_AUDIO_CHANNELS", "1"))
    parser.add_argument("--format", default=env_value("SHAPE_AUDIO_FORMAT", "pcm_f32le"))
    parser.add_argument("--identity", default=env_value("SHAPE_IDENTITY_PATH") or env_value("SHAPE_IDENTITY_URI", ""))
    parser.add_argument("--command-template", default=env_value("VCCLIENT000_CHUNK_COMMAND"))
    parser.add_argument("--http-endpoint", default=env_value("VCCLIENT000_HTTP_ENDPOINT"))
    parser.add_argument("--timeout", type=float, default=float(env_value("VCCLIENT000_TIMEOUT_SECS", "10")))
    parser.add_argument("--passthrough-if-unavailable", action="store_true", default=env_flag("SHAPE_WRAPPER_PASSTHROUGH", False))
    args = parser.parse_args()

    input_path = ensure_file(args.input, "audio input")
    if not args.output:
        fail("audio output no configurado.")

    if args.command_template:
        command = template_args(
            args.command_template,
            {
                "input": str(input_path),
                "output": args.output,
                "sample_rate": args.sample_rate,
                "channels": args.channels,
                "format": args.format,
                "identity": args.identity,
                "session_id": env_value("SHAPE_SESSION_ID", ""),
            },
        )
        run_checked(command, timeout=args.timeout)
        assert_output(args.output)
        return

    if args.http_endpoint:
        call_http_endpoint(args, input_path)
        assert_output(args.output)
        return

    if args.passthrough_if_unavailable:
        raise SystemExit(copy_passthrough(input_path, args.output, "vcclient000 no configurado"))

    fail("Configura VCCLIENT000_CHUNK_COMMAND o VCCLIENT000_HTTP_ENDPOINT.")


def call_http_endpoint(args, input_path):
    payload = {
        "audioDataBase64": base64.b64encode(Path(input_path).read_bytes()).decode("ascii"),
        "sampleRate": int(args.sample_rate),
        "channels": int(args.channels),
        "format": args.format,
        "identity": args.identity,
    }
    request = urllib.request.Request(
        args.http_endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=args.timeout) as response:
            response_body = response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:240]
        fail(f"vcclient000 HTTP {error.code}: {detail}")
    except OSError as error:
        fail(f"vcclient000 HTTP no disponible: {error}")

    try:
        data = json.loads(response_body)
    except json.JSONDecodeError as error:
        fail(f"vcclient000 HTTP devolvió JSON inválido: {error}")

    encoded = data.get("audioDataBase64") or data.get("audio", {}).get("audioDataBase64")
    if not isinstance(encoded, str) or not encoded:
        fail("vcclient000 HTTP no devolvió audioDataBase64.")

    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_bytes(base64.b64decode(encoded))


if __name__ == "__main__":
    main()
