#!/usr/bin/env python3
import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


MAX_BODY_BYTES = 12 * 1024 * 1024
STATE = {
    "startedAt": None,
    "requests": 0,
    "lastLatencyMs": None,
    "lastWarning": None,
}


class ShapeModelEndpointHandler(BaseHTTPRequestHandler):
    server_version = "ShapeMeetModelEndpoint/0.1"

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def do_GET(self):
        if request_path(self.path) != "/health":
            self._json({"error": "not_found"}, status=404)
            return

        self._json(
            {
                "status": "ready",
                "mode": "passthrough" if passthrough_enabled() else "wrappers",
                "demoEffects": demo_effects_enabled(),
                "stages": ["face", "background", "voice"],
                "startedAt": STATE["startedAt"],
                "requests": STATE["requests"],
                "lastLatencyMs": STATE["lastLatencyMs"],
                "lastWarning": STATE["lastWarning"],
            }
        )

    def do_POST(self):
        path = request_path(self.path)
        if path not in {"/face", "/background", "/voice"}:
            self._json({"error": "not_found"}, status=404)
            return

        if int(self.headers.get("content-length", "0")) > MAX_BODY_BYTES:
            self._json({"error": "payload_too_large"}, status=413)
            return

        payload = self._read_json()
        if payload is None:
            self._json({"error": "invalid_json"}, status=400)
            return

        try:
            if path == "/voice":
                self._json(process_voice(payload))
            else:
                self._json(process_video(path.removeprefix("/"), payload))
        except Exception as error:
            update_state(None, str(error))
            self._json({"error": "model_endpoint_failed", "message": str(error)}, status=500)

    def log_message(self, fmt, *args):
        if access_log_enabled():
            print(f"[shape-model-endpoint] {self.address_string()} {fmt % args}")

    def _read_json(self):
        length = int(self.headers.get("content-length", "0"))
        if length <= 0:
            return {}

        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except json.JSONDecodeError:
            return None

    def _json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._cors_headers()
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            print("[shape-model-endpoint] client disconnected before response body was sent")

    def _cors_headers(self):
        self.send_header("access-control-allow-origin", "*")
        self.send_header("access-control-allow-methods", "GET,POST,OPTIONS")
        self.send_header("access-control-allow-headers", "content-type")


def process_video(stage, payload):
    started = time.perf_counter()
    frame = payload.get("frame") if isinstance(payload.get("frame"), dict) else {}
    target = payload.get("target") if isinstance(payload.get("target"), dict) else {}
    identity = payload.get("identity") if isinstance(payload.get("identity"), dict) else {}
    background = payload.get("background") if isinstance(payload.get("background"), dict) else {}
    width = safe_int(target.get("width")) or safe_int(frame.get("width")) or 1280
    height = safe_int(target.get("height")) or safe_int(frame.get("height")) or 720
    fps = safe_int(target.get("fps")) or 30
    sequence = safe_int(payload.get("sequence")) or safe_int(frame.get("sequence")) or 0
    warnings = []

    with tempfile.TemporaryDirectory(prefix=f"shape-model-{stage}-") as workdir:
        input_path = resolve_input_file(
            frame.get("inputPath"),
            frame.get("dataUrl") or frame.get("frameDataUrl"),
            Path(workdir) / "input.jpg",
            "video input",
        )
        output_path = resolve_output_path(frame.get("outputPath"), Path(workdir) / "output.jpg")

        if passthrough_enabled():
            copy_file(input_path, output_path)
            warnings.append(f"{stage}_endpoint_passthrough")
        elif demo_effects_enabled():
            copy_file(input_path, output_path)
            warnings.append(f"{stage}_endpoint_demo")
        else:
            run_video_wrapper(stage, input_path, output_path, identity, background)

        latency_ms = elapsed_ms(started)
        update_state(latency_ms, warnings[-1] if warnings else None)
        return {
            "sequence": sequence,
            "status": "processed",
            "processor": f"shape-{stage}-endpoint-server",
            "frame": {
                "dataUrl": file_to_data_url(output_path, "image/jpeg"),
                "width": width,
                "height": height,
                "format": "image/jpeg",
            },
            "metrics": {
                "latencyMs": latency_ms,
                "fps": fps,
                "vramMb": safe_int(os.environ.get("SHAPE_MODEL_ENDPOINT_VRAM_MB")) or 0,
                "resolution": f"{width}x{height}",
            },
            "warnings": warnings,
        }


def process_voice(payload):
    started = time.perf_counter()
    audio = payload.get("audio") if isinstance(payload.get("audio"), dict) else {}
    identity = payload.get("identity") if isinstance(payload.get("identity"), dict) else {}
    sample_rate = safe_int(audio.get("sampleRate")) or 48000
    channels = safe_int(audio.get("channels")) or 1
    audio_format = str(audio.get("format") or "pcm_f32le")
    sequence = safe_int(payload.get("sequence")) or safe_int(audio.get("sequence")) or 0
    warnings = []

    with tempfile.TemporaryDirectory(prefix="shape-model-voice-") as workdir:
        input_path = resolve_audio_input(
            audio.get("inputPath"),
            audio.get("audioDataBase64"),
            Path(workdir) / f"input.{audio_extension(audio_format)}",
        )
        output_path = resolve_output_path(
            audio.get("outputPath"), Path(workdir) / f"output.{audio_extension(audio_format)}"
        )

        if passthrough_enabled() or demo_effects_enabled():
            copy_file(input_path, output_path)
            warnings.append("voice_endpoint_passthrough")
        else:
            run_voice_wrapper(input_path, output_path, identity, sample_rate, channels, audio_format)

        output_base64 = file_to_base64(output_path)
        latency_ms = elapsed_ms(started)
        update_state(latency_ms, warnings[-1] if warnings else None)
        return {
            "sequence": sequence,
            "status": "processed",
            "processor": "shape-voice-endpoint-server",
            "audio": {
                "audioDataBase64": output_base64,
                "sampleRate": sample_rate,
                "channels": channels,
                "format": audio_format,
            },
            "metrics": {
                "latencyMs": latency_ms,
                "inputBytes": len(output_base64),
            },
            "warnings": warnings,
        }


def run_video_wrapper(stage, input_path, output_path, identity, background):
    if stage == "face":
        identity_path = identity.get("localArtifactPath") or identity.get("cachedArtifactUri") or identity.get("artifactUri")
        if not identity_path:
            raise ValueError("face endpoint requiere identidad local o URI.")
        run_checked(
            [
                wrapper_python(),
                str(wrapper_path("facefusion_frame.py")),
                "--input",
                str(input_path),
                "--output",
                str(output_path),
                "--identity",
                str(identity_path),
            ],
            "face wrapper",
        )
        return

    clean_plate_path = background.get("cleanPlatePath")
    if not clean_plate_path:
        clean_plate = background.get("cleanPlate") if isinstance(background.get("cleanPlate"), dict) else {}
        clean_plate_data_url = clean_plate.get("dataUrl")
        if clean_plate_data_url:
            clean_plate_path = output_path.with_name("clean-plate.jpg")
            write_data_url(clean_plate_data_url, clean_plate_path)
    if not clean_plate_path:
        raise ValueError("background endpoint requiere clean plate.")

    run_checked(
        [
            wrapper_python(),
            str(wrapper_path("backgroundmattingv2_frame.py")),
            "--input",
            str(input_path),
            "--output",
            str(output_path),
            "--clean-plate",
            str(clean_plate_path),
        ],
        "background wrapper",
    )


def run_voice_wrapper(input_path, output_path, identity, sample_rate, channels, audio_format):
    run_checked(
        [
            wrapper_python(),
            str(wrapper_path("vcclient000_chunk.py")),
            "--input",
            str(input_path),
            "--output",
            str(output_path),
            "--sample-rate",
            str(sample_rate),
            "--channels",
            str(channels),
            "--format",
            audio_format,
            "--identity",
            identity.get("localArtifactPath") or identity.get("cachedArtifactUri") or identity.get("artifactUri") or "",
        ],
        "voice wrapper",
    )


def run_checked(args, label):
    try:
        result = subprocess.run(
            args,
            cwd=str(repo_root()),
            env=os.environ.copy(),
            capture_output=True,
            text=True,
            timeout=model_timeout(),
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        detail = captured_output_tail(error.stdout, error.stderr)
        raise RuntimeError(f"{label} agotó timeout {model_timeout()}s: {detail}") from error
    except OSError as error:
        raise RuntimeError(f"{label} no se pudo ejecutar: {error}") from error

    if result.returncode != 0:
        detail = captured_output_tail(result.stdout, result.stderr)
        raise RuntimeError(f"{label} falló con código {result.returncode}: {detail}")

    if not args or "--output" not in args:
        return
    output_path = Path(args[args.index("--output") + 1])
    if not output_path.exists() or output_path.stat().st_size <= 0:
        raise RuntimeError(f"{label} no produjo output válido: {output_path}")


def resolve_input_file(path_value, data_url, fallback_path, label):
    if path_value:
        path = Path(path_value)
        if path.exists() and path.is_file():
            return path

    if isinstance(data_url, str) and data_url.startswith("data:image/"):
        write_data_url(data_url, fallback_path)
        return fallback_path

    raise ValueError(f"{label} no disponible.")


def resolve_audio_input(path_value, encoded, fallback_path):
    if path_value:
        path = Path(path_value)
        if path.exists() and path.is_file():
            return path

    if isinstance(encoded, str) and encoded:
        fallback_path.parent.mkdir(parents=True, exist_ok=True)
        fallback_path.write_bytes(base64.b64decode(encoded))
        return fallback_path

    raise ValueError("audio input no disponible.")


def resolve_output_path(path_value, fallback_path):
    path = Path(path_value) if path_value else fallback_path
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def copy_file(input_path, output_path):
    output_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(input_path, output_path)


def write_data_url(data_url, path):
    try:
        _, encoded = data_url.split(",", 1)
    except ValueError as error:
        raise ValueError("invalid_data_url") from error

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(base64.b64decode(encoded))


def file_to_data_url(path, mime_type):
    return f"data:{mime_type};base64,{file_to_base64(path)}"


def file_to_base64(path):
    return base64.b64encode(Path(path).read_bytes()).decode("ascii")


def update_state(latency_ms, warning):
    STATE["requests"] += 1
    if latency_ms is not None:
        STATE["lastLatencyMs"] = latency_ms
    if warning:
        STATE["lastWarning"] = warning


def request_path(path):
    return path.split("?", 1)[0]


def repo_root():
    return Path(__file__).resolve().parents[3]


def wrapper_path(file_name):
    return repo_root() / "apps" / "ai-sidecar" / "wrappers" / file_name


def wrapper_python():
    return os.environ.get("SHAPE_MODEL_ENDPOINT_PYTHON") or os.environ.get("SHAPE_AI_PYTHON") or sys.executable


def passthrough_enabled():
    return env_flag("SHAPE_MODEL_ENDPOINT_PASSTHROUGH") or env_flag("SHAPE_WRAPPER_PASSTHROUGH")


def demo_effects_enabled():
    return env_flag("SHAPE_MODEL_ENDPOINT_DEMO_EFFECTS")


def access_log_enabled():
    return env_flag("SHAPE_MODEL_ENDPOINT_ACCESS_LOG")


def env_flag(name):
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def model_timeout():
    return max(
        0.1,
        min(
            120.0,
            safe_float(os.environ.get("SHAPE_MODEL_ENDPOINT_TIMEOUT_SECS"))
            or safe_float(os.environ.get("SHAPE_MODEL_COMMAND_TIMEOUT_SECS"))
            or 30.0,
        ),
    )


def audio_extension(audio_format):
    normalized = audio_format.lower()
    if "s16" in normalized or "int16" in normalized:
        return "s16le"
    if "u8" in normalized or "uint8" in normalized:
        return "u8"
    return "f32le"


def captured_output_tail(stdout, stderr, limit=500):
    text = "\n".join(part for part in (normalize_output(stderr), normalize_output(stdout)) if part)
    return " ".join(text.split())[-limit:]


def normalize_output(value):
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)


def elapsed_ms(started):
    return max(1, int((time.perf_counter() - started) * 1000))


def safe_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def safe_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def main():
    parser = argparse.ArgumentParser(description="Shape Meet persistent model endpoint server")
    parser.add_argument("--host", default=os.environ.get("SHAPE_MODEL_ENDPOINT_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=safe_int(os.environ.get("SHAPE_MODEL_ENDPOINT_PORT")) or 9100)
    parser.add_argument("--passthrough", action="store_true", help="Copy input to output instead of calling wrappers.")
    parser.add_argument("--demo-effects", action="store_true", help="Return lightweight visible demo frame effects.")
    args = parser.parse_args()

    if args.passthrough:
        os.environ["SHAPE_MODEL_ENDPOINT_PASSTHROUGH"] = "true"
    if args.demo_effects:
        os.environ["SHAPE_MODEL_ENDPOINT_DEMO_EFFECTS"] = "true"

    STATE["startedAt"] = datetime.now(timezone.utc).isoformat()
    server = ThreadingHTTPServer((args.host, args.port), ShapeModelEndpointHandler)
    print(f"[shape-model-endpoint] listening on http://{args.host}:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
