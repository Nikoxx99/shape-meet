#!/usr/bin/env python3
import argparse
import base64
import json
import struct
import time
import urllib.error
import urllib.parse
import urllib.request
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
    parser.add_argument("--voice-model", default=env_value("SHAPE_VOICE_MODEL_PATH", ""))
    parser.add_argument("--voice-index", default=env_value("SHAPE_VOICE_INDEX_PATH", ""))
    parser.add_argument("--voice-config", default=env_value("SHAPE_VOICE_CONFIG_PATH", ""))
    parser.add_argument("--command-template", default=env_value("VCCLIENT000_CHUNK_COMMAND"))
    parser.add_argument("--http-endpoint", default=env_value("VCCLIENT000_HTTP_ENDPOINT"))
    parser.add_argument("--http-mode", default=env_value("VCCLIENT000_HTTP_MODE", "auto"))
    parser.add_argument("--timeout", type=float, default=env_float("VCCLIENT000_TIMEOUT_SECS", "10", minimum=0.1))
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
                "voice_model": args.voice_model,
                "voice_index": args.voice_index,
                "voice_config": args.voice_config,
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
    mode = normalize_http_mode(args.http_mode, args.http_endpoint)
    if mode == "w-okada-rest":
        call_w_okada_rest_endpoint(args, input_path)
        return
    if mode == "shape-json":
        call_shape_json_endpoint(args, input_path)
        return

    fail(f"VCCLIENT000_HTTP_MODE no soportado: {args.http_mode}")


def normalize_http_mode(mode, endpoint):
    normalized = str(mode or "auto").strip().lower().replace("_", "-")
    if normalized in {"shape", "shape-json", "shape-meet"}:
        return "shape-json"
    if normalized in {"w-okada", "w-okada-rest", "vcclient", "vcclient-rest"}:
        return "w-okada-rest"
    if normalized != "auto":
        return normalized

    parsed = urllib.parse.urlparse(endpoint)
    path = (parsed.path or "").rstrip("/")
    if path in {"", "/test"} or path.endswith("/test"):
        return "w-okada-rest"
    return "shape-json"


def call_shape_json_endpoint(args, input_path):
    payload = {
        "audioDataBase64": base64.b64encode(Path(input_path).read_bytes()).decode("ascii"),
        "sampleRate": int(args.sample_rate),
        "channels": int(args.channels),
        "format": args.format,
        "identity": args.identity,
        "voiceModelPath": args.voice_model,
        "voiceIndexPath": args.voice_index,
        "voiceConfigPath": args.voice_config,
    }
    data = post_json(args.http_endpoint, payload, args.timeout, "vcclient000 HTTP")

    encoded = data.get("audioDataBase64") or data.get("audio", {}).get("audioDataBase64")
    if not isinstance(encoded, str) or not encoded:
        fail("vcclient000 HTTP no devolvió audioDataBase64.")

    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_bytes(base64.b64decode(encoded))


def call_w_okada_rest_endpoint(args, input_path):
    endpoint = normalize_w_okada_endpoint(args.http_endpoint)
    channels = max(1, int(args.channels))
    input_s16 = audio_bytes_to_s16_mono(Path(input_path).read_bytes(), args.format, channels)
    payload = {
        "timestamp": int(time.time() * 1000),
        "buffer": base64.b64encode(input_s16).decode("ascii"),
    }
    data = post_json(endpoint, payload, args.timeout, "vcclient000 w-okada REST")

    encoded = data.get("changedVoiceBase64") or data.get("data", {}).get("changedVoiceBase64")
    if not isinstance(encoded, str) or not encoded:
        fail("vcclient000 w-okada REST no devolvió changedVoiceBase64.")

    output_s16 = base64.b64decode(encoded)
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_bytes(s16_mono_to_audio_bytes(output_s16, args.format, channels))


def normalize_w_okada_endpoint(endpoint):
    parsed = urllib.parse.urlparse(endpoint)
    if parsed.path and parsed.path not in {"", "/"}:
        return endpoint
    return urllib.parse.urlunparse(parsed._replace(path="/test"))


def post_json(endpoint, payload, timeout, label):
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            response_body = response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:240]
        fail(f"{label} {error.code}: {detail}")
    except OSError as error:
        fail(f"{label} no disponible: {error}")

    try:
        return json.loads(response_body)
    except json.JSONDecodeError as error:
        fail(f"{label} devolvió JSON inválido: {error}")


def audio_bytes_to_s16_mono(raw, audio_format, channels):
    normalized = audio_format.lower()
    if normalized in {"pcm_f32le", "f32le", "float32"}:
        sample_count = len(raw) // 4
        samples = [
            int16_from_float(value[0])
            for value in struct.iter_unpack("<f", raw[: sample_count * 4])
        ]
        return pack_mono_s16(downmix_int16(samples, channels))

    if normalized in {"pcm_s16le", "s16le", "int16"}:
        sample_count = len(raw) // 2
        samples = [
            value[0]
            for value in struct.iter_unpack("<h", raw[: sample_count * 2])
        ]
        return pack_mono_s16(downmix_int16(samples, channels))

    if normalized in {"uint8-time-domain", "u8", "uint8"}:
        samples = [int(round(((byte - 128) / 128) * 32767)) for byte in raw]
        return pack_mono_s16(downmix_int16(samples, channels))

    fail(f"Formato de audio no soportado para vcclient000 w-okada REST: {audio_format}")


def s16_mono_to_audio_bytes(raw, audio_format, channels):
    sample_count = len(raw) // 2
    mono = [value[0] for value in struct.iter_unpack("<h", raw[: sample_count * 2])]
    expanded = expand_mono(mono, channels)
    normalized = audio_format.lower()

    if normalized in {"pcm_f32le", "f32le", "float32"}:
        return b"".join(struct.pack("<f", max(-1.0, min(1.0, sample / 32768.0))) for sample in expanded)

    if normalized in {"pcm_s16le", "s16le", "int16"}:
        return pack_mono_s16(expanded)

    if normalized in {"uint8-time-domain", "u8", "uint8"}:
        return bytes(max(0, min(255, int(round((sample / 32768.0) * 128 + 128)))) for sample in expanded)

    fail(f"Formato de salida no soportado para vcclient000 w-okada REST: {audio_format}")


def downmix_int16(samples, channels):
    if channels <= 1:
        return samples

    frame_count = len(samples) // channels
    mixed = []
    for frame in range(frame_count):
        start = frame * channels
        mixed.append(int(round(sum(samples[start : start + channels]) / channels)))
    return mixed


def expand_mono(samples, channels):
    if channels <= 1:
        return samples
    expanded = []
    for sample in samples:
        expanded.extend([sample] * channels)
    return expanded


def int16_from_float(value):
    clamped = max(-1.0, min(1.0, float(value)))
    return int(round(clamped * (32768 if clamped < 0 else 32767)))


def pack_mono_s16(samples):
    return b"".join(struct.pack("<h", max(-32768, min(32767, int(sample)))) for sample in samples)


if __name__ == "__main__":
    main()
