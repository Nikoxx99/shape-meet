#!/usr/bin/env python3
import argparse
import base64
import html
import json
import os
import platform
import shlex
import subprocess
import tempfile
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote


DEFAULT_VIDEO_PORT = 7860
DEFAULT_AUDIO_PORT = 7861
MAX_BODY_BYTES = 10 * 1024 * 1024
STATE = {
    "kind": "video",
    "startedAt": None,
    "requests": 0,
    "lastLatencyMs": None,
    "lastWarning": None,
}
STATE_LOCK = threading.Lock()


class ShapeProcessorHandler(BaseHTTPRequestHandler):
    server_version = "ShapeMeetCommandProcessor/0.1"

    def do_GET(self):
        if self.path.split("?", 1)[0] != "/health":
            self._json({"error": "not_found"}, status=404)
            return

        kind = STATE["kind"]
        command = any_model_command_configured(kind)
        demo_effects = demo_effects_enabled()
        self._json(
            {
                "status": "ready" if command or demo_effects else "limited",
                "kind": kind,
                "mode": "command" if command else "demo-effects" if demo_effects else "passthrough",
                "commandConfigured": bool(command),
                "demoEffects": demo_effects,
                "startedAt": STATE["startedAt"],
                "requests": STATE["requests"],
                "lastLatencyMs": STATE["lastLatencyMs"],
                "lastWarning": STATE["lastWarning"],
            }
        )

    def do_POST(self):
        kind = STATE["kind"]
        path = self.path.split("?", 1)[0]
        expected_path = "/process-frame" if kind == "video" else "/process-audio"

        if path != expected_path:
            self._json({"error": "not_found"}, status=404)
            return

        if int(self.headers.get("content-length", "0")) > MAX_BODY_BYTES:
            self._json({"error": "payload_too_large"}, status=413)
            return

        payload = self._read_json()
        if payload is None:
            self._json({"error": "invalid_json"}, status=400)
            return

        if kind == "video":
            self._json({"frame": process_video(payload)})
        else:
            self._json({"audio": process_audio(payload)})

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def log_message(self, fmt, *args):
        print(f"[shape-{STATE['kind']}-processor] {self.address_string()} {fmt % args}")

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
            print(f"[shape-{STATE['kind']}-processor] client disconnected before response body was sent")

    def _cors_headers(self):
        self.send_header("access-control-allow-origin", "*")
        self.send_header("access-control-allow-methods", "GET,POST,OPTIONS")
        self.send_header("access-control-allow-headers", "content-type")


def process_video(payload):
    started = time.perf_counter()
    frame = payload.get("frame") if isinstance(payload.get("frame"), dict) else {}
    target = payload.get("target") if isinstance(payload.get("target"), dict) else {}
    identity = payload.get("identity") if isinstance(payload.get("identity"), dict) else {}
    background = payload.get("background") if isinstance(payload.get("background"), dict) else {}
    enabled = payload.get("enabled") if isinstance(payload.get("enabled"), dict) else {}
    width = safe_int(target.get("width")) or safe_int(frame.get("width")) or 1280
    height = safe_int(target.get("height")) or safe_int(frame.get("height")) or 720
    fps = safe_int(target.get("fps")) or 30
    sequence = safe_int(frame.get("sequence")) or 0
    input_data_url = frame.get("frameDataUrl")
    warnings = []
    output_data_url = input_data_url if isinstance(input_data_url, str) else ""
    status = "passthrough"
    processor = "shape-video-command-adapter"

    if not isinstance(input_data_url, str) or not input_data_url.startswith("data:image/"):
        warnings.append("invalid_frame_data_url")
    else:
        command = combined_model_command("video")
        stage_commands = video_stage_commands(enabled) if not command else []
        if command:
            with tempfile.TemporaryDirectory(prefix="shape-video-") as workdir:
                input_path = os.path.join(workdir, "input.jpg")
                output_path = os.path.join(workdir, "output.jpg")
                clean_plate_path = write_clean_plate(background, workdir)
                write_data_url(input_data_url, input_path)

                result = run_model_command(
                    command,
                    {
                        "input": input_path,
                        "output": output_path,
                        "identity": identity.get("localArtifactPath") or identity.get("cachedArtifactUri") or identity.get("artifactUri") or "",
                        "clean_plate": clean_plate_path or "",
                        "width": str(width),
                        "height": str(height),
                        "fps": str(fps),
                        "session_id": session_id(payload),
                    },
                    {
                        "SHAPE_FRAME_INPUT_PATH": input_path,
                        "SHAPE_FRAME_OUTPUT_PATH": output_path,
                        "SHAPE_IDENTITY_PATH": identity.get("localArtifactPath") or "",
                        "SHAPE_IDENTITY_URI": identity.get("cachedArtifactUri") or identity.get("artifactUri") or "",
                        "SHAPE_CLEAN_PLATE_PATH": clean_plate_path or "",
                        "SHAPE_TARGET_WIDTH": str(width),
                        "SHAPE_TARGET_HEIGHT": str(height),
                        "SHAPE_TARGET_FPS": str(fps),
                    },
                )
                warnings.extend(result["warnings"])

                if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
                    output_data_url = file_to_data_url(output_path, "image/jpeg")
                    status = "processed"
                elif result["ok"]:
                    warnings.append("video_model_output_missing")
        elif stage_commands:
            with tempfile.TemporaryDirectory(prefix="shape-video-") as workdir:
                input_path = os.path.join(workdir, "input.jpg")
                clean_plate_path = write_clean_plate(background, workdir)
                write_data_url(input_data_url, input_path)
                current_input_path = input_path
                completed_stages = []

                for stage, stage_command in stage_commands:
                    output_path = os.path.join(workdir, f"output-{stage}.jpg")
                    result = run_model_command(
                        stage_command,
                        {
                            "input": current_input_path,
                            "output": output_path,
                            "identity": identity.get("localArtifactPath") or identity.get("cachedArtifactUri") or identity.get("artifactUri") or "",
                            "clean_plate": clean_plate_path or "",
                            "width": str(width),
                            "height": str(height),
                            "fps": str(fps),
                            "session_id": session_id(payload),
                            "stage": stage,
                        },
                        {
                            "SHAPE_FRAME_INPUT_PATH": current_input_path,
                            "SHAPE_FRAME_OUTPUT_PATH": output_path,
                            "SHAPE_VIDEO_STAGE": stage,
                            "SHAPE_IDENTITY_PATH": identity.get("localArtifactPath") or "",
                            "SHAPE_IDENTITY_URI": identity.get("cachedArtifactUri") or identity.get("artifactUri") or "",
                            "SHAPE_CLEAN_PLATE_PATH": clean_plate_path or "",
                            "SHAPE_TARGET_WIDTH": str(width),
                            "SHAPE_TARGET_HEIGHT": str(height),
                            "SHAPE_TARGET_FPS": str(fps),
                        },
                    )
                    warnings.extend(prefix_warnings(stage, result["warnings"]))

                    if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
                        current_input_path = output_path
                        completed_stages.append(stage)
                        continue

                    if result["ok"]:
                        warnings.append(f"{stage}_model_output_missing")

                if completed_stages:
                    output_data_url = file_to_data_url(current_input_path, "image/jpeg")
                    status = "processed"
                    processor = "shape-video-model-chain:" + "+".join(completed_stages)
        elif demo_effects_enabled():
            output_data_url = demo_video_data_url(payload, input_data_url, width, height, sequence)
            status = "processed"
            processor = "shape-demo-video-processor"
            warnings.append("demo_video_processor")

    latency_ms = elapsed_ms(started)
    update_state(latency_ms, warnings[-1] if warnings else None)
    return {
        "sequence": sequence,
        "status": status,
        "processor": processor,
        "frame": {
            "dataUrl": output_data_url,
            "width": width,
            "height": height,
            "format": "image/jpeg",
        },
        "metrics": {
            "fps": fps,
            "latencyMs": latency_ms,
            "framesProcessed": STATE["requests"],
            "vramMb": safe_int(os.environ.get("SHAPE_VIDEO_VRAM_MB")) or 0,
            "resolution": f"{width}x{height}",
        },
        "warnings": unique_warnings(warnings),
    }


def process_audio(payload):
    started = time.perf_counter()
    audio = payload.get("audio") if isinstance(payload.get("audio"), dict) else {}
    sequence = safe_int(audio.get("sequence")) or 0
    sample_rate = safe_int(audio.get("sampleRate")) or 48000
    channels = safe_int(audio.get("channels")) or 1
    audio_format = str(audio.get("format") or "pcm_f32le")
    input_base64 = audio.get("audioDataBase64")
    output_base64 = input_base64 if isinstance(input_base64, str) else ""
    identity = payload.get("identity") if isinstance(payload.get("identity"), dict) else {}
    enabled = payload.get("enabled") if isinstance(payload.get("enabled"), dict) else {}
    warnings = []
    status = "passthrough"
    processor = "shape-audio-command-adapter"

    if not isinstance(input_base64, str) or not input_base64:
        warnings.append("invalid_audio_payload")
    else:
        command = combined_model_command("audio") or voice_stage_command(enabled)
        if command:
            with tempfile.TemporaryDirectory(prefix="shape-audio-") as workdir:
                input_path = os.path.join(workdir, f"input.{audio_extension(audio_format)}")
                output_path = os.path.join(workdir, f"output.{audio_extension(audio_format)}")
                write_base64(input_base64, input_path)

                result = run_model_command(
                    command,
                    {
                        "input": input_path,
                        "output": output_path,
                        "sample_rate": str(sample_rate),
                        "channels": str(channels),
                        "format": audio_format,
                        "session_id": session_id(payload),
                        "identity": identity.get("localArtifactPath") or identity.get("cachedArtifactUri") or identity.get("artifactUri") or "",
                    },
                    {
                        "SHAPE_AUDIO_INPUT_PATH": input_path,
                        "SHAPE_AUDIO_OUTPUT_PATH": output_path,
                        "SHAPE_AUDIO_SAMPLE_RATE": str(sample_rate),
                        "SHAPE_AUDIO_CHANNELS": str(channels),
                        "SHAPE_AUDIO_FORMAT": audio_format,
                        "SHAPE_IDENTITY_PATH": identity.get("localArtifactPath") or "",
                        "SHAPE_IDENTITY_URI": identity.get("cachedArtifactUri") or identity.get("artifactUri") or "",
                    },
                )
                warnings.extend(result["warnings"])

                if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
                    output_base64 = file_to_base64(output_path)
                    status = "processed"
                    if not combined_model_command("audio"):
                        processor = "shape-voice-command-adapter"
                elif result["ok"]:
                    warnings.append("audio_model_output_missing")
        elif demo_effects_enabled():
            status = "processed"
            processor = "shape-demo-audio-processor"
            warnings.append("demo_audio_passthrough")

    latency_ms = elapsed_ms(started)
    update_state(latency_ms, warnings[-1] if warnings else None)
    return {
        "sequence": sequence,
        "status": status,
        "processor": processor,
        "audio": {
            "audioDataBase64": output_base64,
            "sampleRate": sample_rate,
            "channels": channels,
            "format": audio_format,
        },
        "metrics": {
            "chunksProcessed": STATE["requests"],
            "latencyMs": latency_ms,
            "inputBytes": len(output_base64),
        },
        "warnings": unique_warnings(warnings),
    }


def run_model_command(command, replacements, extra_env):
    args = command_args(command, replacements)
    env = os.environ.copy()
    env.update({key: value for key, value in extra_env.items() if value is not None})

    try:
        result = subprocess.run(
            args,
            env=env,
            capture_output=True,
            text=True,
            timeout=model_timeout(),
            check=False,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "warnings": ["model_command_timeout"]}
    except Exception as error:
        return {"ok": False, "warnings": [f"model_command_error:{str(error)[:160]}"]}

    if result.returncode == 0:
        return {"ok": True, "warnings": command_warnings(result)}

    detail = (result.stderr or result.stdout or "").strip().replace("\n", " ")[:180]
    warning = f"model_command_failed:{result.returncode}"
    if detail:
        warning = f"{warning}:{detail}"
    return {"ok": False, "warnings": [warning]}


def command_args(command, replacements):
    try:
        parts = shlex.split(command, posix=platform.system() != "Windows")
    except ValueError:
        parts = command.split()

    return [replace_placeholders(part, replacements) for part in parts]


def replace_placeholders(value, replacements):
    for key, replacement in replacements.items():
        value = value.replace("{" + key + "}", replacement)
    return value


def command_warnings(result):
    warnings = []
    stderr = (result.stderr or "").strip()
    if stderr:
        warnings.append(f"model_command_stderr:{stderr.replace(chr(10), ' ')[:180]}")
    return warnings


def combined_model_command(kind):
    if kind == "audio":
        return env_non_empty("SHAPE_AUDIO_CHUNK_COMMAND")
    return env_non_empty("SHAPE_VIDEO_FRAME_COMMAND")


def any_model_command_configured(kind):
    if combined_model_command(kind):
        return True

    if kind == "audio":
        return bool(env_non_empty("SHAPE_VOICE_COMMAND"))

    return bool(env_non_empty("SHAPE_FACE_COMMAND") or env_non_empty("SHAPE_BACKGROUND_COMMAND"))


def video_stage_commands(enabled):
    commands = []
    if enabled.get("face"):
        command = env_non_empty("SHAPE_FACE_COMMAND")
        if command:
            commands.append(("face", command))
    if enabled.get("background"):
        command = env_non_empty("SHAPE_BACKGROUND_COMMAND")
        if command:
            commands.append(("background", command))
    return commands


def voice_stage_command(enabled):
    if not enabled.get("voice"):
        return None
    return env_non_empty("SHAPE_VOICE_COMMAND")


def prefix_warnings(stage, warnings):
    return [f"{stage}:{warning}" for warning in warnings]


def demo_effects_enabled():
    return str(os.environ.get("SHAPE_PROCESSOR_DEMO_EFFECTS", "")).strip().lower() in {"1", "true", "yes", "on"}


def demo_video_data_url(payload, input_data_url, width, height, sequence):
    identity = payload.get("identity") if isinstance(payload.get("identity"), dict) else {}
    enabled = payload.get("enabled") if isinstance(payload.get("enabled"), dict) else {}
    background = payload.get("background") if isinstance(payload.get("background"), dict) else {}
    clean_plate = background.get("cleanPlate") if isinstance(background.get("cleanPlate"), dict) else {}
    identity_label = identity.get("version") or identity.get("id") or "identidad demo"
    effects = [
        label
        for enabled_flag, label in (
            (enabled.get("face"), "rostro"),
            (enabled.get("background"), "fondo"),
            (enabled.get("voice"), "voz"),
        )
        if enabled_flag
    ]
    effect_label = " + ".join(effects) if effects else "passthrough"
    plate_label = "clean plate" if clean_plate.get("ready") else "sin clean plate"
    safe_frame = html.escape(input_data_url, quote=True)
    safe_identity = html.escape(str(identity_label), quote=True)
    safe_effects = html.escape(effect_label, quote=True)
    safe_plate = html.escape(plate_label, quote=True)
    safe_resolution = html.escape(f"{width}x{height}", quote=True)
    pulse_x = 58 + (sequence % 18) * 6

    svg = f"""
<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">
  <defs>
    <linearGradient id="shape-demo-glow" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="#2563eb" stop-opacity="0.18"/>
      <stop offset="0.55" stop-color="#14b8a6" stop-opacity="0.10"/>
      <stop offset="1" stop-color="#0f172a" stop-opacity="0.18"/>
    </linearGradient>
    <filter id="shape-demo-soft">
      <feGaussianBlur stdDeviation="18"/>
    </filter>
  </defs>
  <rect width="{width}" height="{height}" fill="#0f172a"/>
  <image href="{safe_frame}" width="{width}" height="{height}" preserveAspectRatio="xMidYMid slice"/>
  <rect width="{width}" height="{height}" fill="url(#shape-demo-glow)"/>
  <ellipse cx="{int(width * 0.5)}" cy="{int(height * 0.42)}" rx="{int(width * 0.18)}" ry="{int(height * 0.27)}" fill="none" stroke="#60a5fa" stroke-width="5" stroke-opacity="0.72"/>
  <rect x="28" y="28" width="286" height="92" rx="14" fill="#020617" fill-opacity="0.72"/>
  <circle cx="{pulse_x}" cy="74" r="12" fill="#22c55e"/>
  <text x="86" y="66" fill="#ffffff" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="700">IA demo activa</text>
  <text x="86" y="94" fill="#bfdbfe" font-family="Inter, Arial, sans-serif" font-size="14">{safe_effects}</text>
  <rect x="28" y="{height - 116}" width="{width - 56}" height="88" rx="16" fill="#020617" fill-opacity="0.72"/>
  <text x="56" y="{height - 74}" fill="#ffffff" font-family="Inter, Arial, sans-serif" font-size="20" font-weight="700">{safe_identity}</text>
  <text x="56" y="{height - 44}" fill="#cbd5e1" font-family="Inter, Arial, sans-serif" font-size="14">{safe_resolution} · {safe_plate} · frame {sequence}</text>
</svg>
""".strip()
    return f"data:image/svg+xml;charset=utf-8,{quote(svg, safe='')}"


def model_timeout():
    return max(0.1, min(30.0, safe_float(os.environ.get("SHAPE_MODEL_COMMAND_TIMEOUT_SECS"), 2.0)))


def write_clean_plate(background, workdir):
    clean_plate = background.get("cleanPlate") if isinstance(background.get("cleanPlate"), dict) else {}
    data_url = clean_plate.get("dataUrl")
    if not isinstance(data_url, str) or not data_url.startswith("data:image/"):
        return None

    path = os.path.join(workdir, "clean-plate.jpg")
    write_data_url(data_url, path)
    return path


def write_data_url(data_url, path):
    try:
        _, encoded = data_url.split(",", 1)
    except ValueError as error:
        raise ValueError("invalid_data_url") from error

    with open(path, "wb") as file:
        file.write(base64.b64decode(encoded))


def write_base64(encoded, path):
    with open(path, "wb") as file:
        file.write(base64.b64decode(encoded))


def file_to_data_url(path, mime_type):
    return f"data:{mime_type};base64,{file_to_base64(path)}"


def file_to_base64(path):
    with open(path, "rb") as file:
        return base64.b64encode(file.read()).decode("ascii")


def audio_extension(audio_format):
    normalized = audio_format.lower()
    if "s16" in normalized or "int16" in normalized:
        return "s16le"
    if "u8" in normalized or "uint8" in normalized:
        return "u8"
    return "f32le"


def session_id(payload):
    session = payload.get("session") if isinstance(payload.get("session"), dict) else {}
    return str(session.get("id") or "")


def update_state(latency_ms, warning):
    with STATE_LOCK:
        STATE["requests"] += 1
        STATE["lastLatencyMs"] = latency_ms
        STATE["lastWarning"] = warning


def elapsed_ms(started):
    return max(1, int((time.perf_counter() - started) * 1000))


def safe_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def safe_float(value, default):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def env_non_empty(key):
    value = os.environ.get(key)
    if value is None:
        return None
    value = value.strip()
    return value or None


def unique_warnings(values):
    unique = []
    for value in values:
        if not value:
            continue
        text = str(value)
        if text not in unique:
            unique.append(text)
    return unique


def main():
    parser = argparse.ArgumentParser(description="Shape Meet command-backed model processor")
    parser.add_argument("--kind", choices=["video", "audio"], default=os.environ.get("SHAPE_PROCESSOR_KIND", "video"))
    parser.add_argument("--host", default=os.environ.get("SHAPE_PROCESSOR_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=None)
    args = parser.parse_args()

    port = args.port or safe_int(os.environ.get("SHAPE_PROCESSOR_PORT"))
    if not port:
        port = DEFAULT_AUDIO_PORT if args.kind == "audio" else DEFAULT_VIDEO_PORT

    STATE["kind"] = args.kind
    STATE["startedAt"] = datetime.now(timezone.utc).isoformat()
    server = ThreadingHTTPServer((args.host, port), ShapeProcessorHandler)
    print(f"[shape-{args.kind}-processor] listening on http://{args.host}:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
