#!/usr/bin/env python3
import argparse
import base64
import html
import json
import math
import os
import shlex
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# The engines package lives at apps/ai-sidecar/engines; ensure it is importable
# when this file is launched directly as apps/ai-sidecar/processors/...py.
_AI_SIDECAR_DIR = Path(__file__).resolve().parents[1]
if str(_AI_SIDECAR_DIR) not in sys.path:
    sys.path.insert(0, str(_AI_SIDECAR_DIR))

import engines as engines_pkg  # noqa: E402  (stdlib-only import surface)


MAX_BODY_BYTES = 12 * 1024 * 1024
STATE = {
    "startedAt": None,
    "requests": 0,
    "lastLatencyMs": None,
    "lastWarning": None,
}


class ShapeModelEndpointHandler(BaseHTTPRequestHandler):
    server_version = "ShapeMeetModelEndpoint/0.1"
    # HTTP/1.1 keeps the loopback connection alive between frames (keep-alive);
    # every response sends an accurate Content-Length so this is safe.
    protocol_version = "HTTP/1.1"

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def do_GET(self):
        path = request_path(self.path)
        if path == "/diagnostics":
            self._json({"diagnostics": diagnostics_payload()})
            return

        if path != "/health":
            self._json({"error": "not_found"}, status=404)
            return

        diagnostics = diagnostics_payload()
        self._json(
            {
                "status": "ready" if diagnostics["ready"] else "limited",
                "mode": endpoint_mode(),
                "demoEffects": demo_effects_enabled(),
                "stages": ["video-frame", "face", "background", "voice"],
                "startedAt": STATE["startedAt"],
                "requests": STATE["requests"],
                "lastLatencyMs": STATE["lastLatencyMs"],
                "lastWarning": STATE["lastWarning"],
                "stageStatus": diagnostics["stageStatus"],
            }
        )

    def do_POST(self):
        path = request_path(self.path)
        if path not in {
            "/video-frame",
            "/face",
            "/background",
            "/voice",
            "/process-frame",
            "/process-audio",
        }:
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
            # /process-frame and /process-audio speak the sidecar contract that
            # server.py already knows (wrapped in {frame} / {audio}); they collapse
            # the shape_processor_command hop away.
            if path == "/process-frame":
                self._json({"frame": process_video_frame(payload)})
            elif path == "/process-audio":
                self._json({"audio": process_voice(payload)})
            elif path == "/voice":
                self._json(process_voice(payload))
            elif path == "/video-frame":
                self._json(process_video_frame(payload))
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

    if inproc_enabled():
        stage_enabled = {stage: True} if stage in {"face", "background"} else {"face": True, "background": True}
        return process_video_frame_inproc(
            payload, frame, identity, background, stage_enabled, width, height, fps, sequence, started,
            processor=f"shape-{stage}-endpoint-server",
        )

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
            output_data_url = file_to_image_data_url(output_path)
            warnings.append(f"{stage}_endpoint_passthrough")
        elif demo_effects_enabled():
            output_data_url = demo_video_data_url(stage, payload, frame, identity, background, width, height, sequence)
            write_data_url(output_data_url, output_path)
            warnings.append(f"{stage}_endpoint_demo_effect")
        else:
            run_video_wrapper(stage, input_path, output_path, identity, background)
            output_data_url = file_to_image_data_url(output_path)

        latency_ms = elapsed_ms(started)
        update_state(latency_ms, warnings[-1] if warnings else None)
        return {
            "sequence": sequence,
            "status": "processed",
            "processor": f"shape-{stage}-endpoint-server",
            "frame": {
                "dataUrl": output_data_url,
                "width": width,
                "height": height,
                "format": data_url_mime_type(output_data_url),
            },
            "metrics": {
                "latencyMs": latency_ms,
                "fps": fps,
                "vramMb": safe_int(os.environ.get("SHAPE_MODEL_ENDPOINT_VRAM_MB")) or 0,
                "resolution": f"{width}x{height}",
            },
            "warnings": warnings,
        }


def process_video_frame(payload):
    started = time.perf_counter()
    frame = payload.get("frame") if isinstance(payload.get("frame"), dict) else {}
    target = payload.get("target") if isinstance(payload.get("target"), dict) else {}
    identity = payload.get("identity") if isinstance(payload.get("identity"), dict) else {}
    background = payload.get("background") if isinstance(payload.get("background"), dict) else {}
    enabled = payload.get("enabled") if isinstance(payload.get("enabled"), dict) else {}
    width = safe_int(target.get("width")) or safe_int(frame.get("width")) or 1280
    height = safe_int(target.get("height")) or safe_int(frame.get("height")) or 720
    fps = safe_int(target.get("fps")) or 30
    sequence = safe_int(payload.get("sequence")) or safe_int(frame.get("sequence")) or 0
    warnings = []

    if inproc_enabled():
        return process_video_frame_inproc(
            payload, frame, identity, background, enabled, width, height, fps, sequence, started
        )

    with tempfile.TemporaryDirectory(prefix="shape-model-video-frame-") as workdir:
        workdir_path = Path(workdir)
        input_path = resolve_input_file(
            frame.get("inputPath"),
            frame.get("dataUrl") or frame.get("frameDataUrl"),
            workdir_path / "input.jpg",
            "video input",
        )
        output_path = resolve_output_path(frame.get("outputPath"), workdir_path / "output.jpg")

        if passthrough_enabled():
            copy_file(input_path, output_path)
            output_data_url = file_to_image_data_url(output_path)
            warnings.append("video_frame_endpoint_passthrough")
        elif demo_effects_enabled():
            output_data_url = demo_video_data_url(
                "video-frame",
                payload,
                frame,
                identity,
                background,
                width,
                height,
                sequence,
            )
            write_data_url(output_data_url, output_path)
            warnings.append("video_frame_endpoint_demo_effect")
        else:
            completed_stages = run_video_frame_wrappers(
                input_path,
                output_path,
                identity,
                background,
                enabled,
                workdir_path,
            )
            output_data_url = file_to_image_data_url(output_path)
            if completed_stages:
                warnings.append("video_frame_endpoint_chain:" + "+".join(completed_stages))

        latency_ms = elapsed_ms(started)
        update_state(latency_ms, warnings[-1] if warnings else None)
        return {
            "sequence": sequence,
            "status": "processed",
            "processor": "shape-video-frame-endpoint-server",
            "frame": {
                "dataUrl": output_data_url,
                "width": width,
                "height": height,
                "format": data_url_mime_type(output_data_url),
            },
            "metrics": {
                "latencyMs": latency_ms,
                "fps": fps,
                "vramMb": safe_int(os.environ.get("SHAPE_MODEL_ENDPOINT_VRAM_MB")) or 0,
                "resolution": f"{width}x{height}",
            },
            "warnings": warnings,
        }


def run_video_frame_wrappers(input_path, output_path, identity, background, enabled, workdir_path):
    stages = []
    if enabled.get("face"):
        stages.append("face")
    if enabled.get("background"):
        stages.append("background")

    if not stages:
        copy_file(input_path, output_path)
        return []

    current_input = input_path
    completed = []
    for index, stage in enumerate(stages):
        stage_output = output_path if index == len(stages) - 1 else workdir_path / f"{stage}.jpg"
        run_video_wrapper(stage, current_input, stage_output, identity, background)
        current_input = stage_output
        completed.append(stage)

    if current_input != output_path:
        copy_file(current_input, output_path)

    return completed


def inproc_enabled():
    return engines_pkg.engine_mode() == "inproc"


def session_id_from_payload(payload):
    session = payload.get("session") if isinstance(payload.get("session"), dict) else {}
    return str(session.get("id") or payload.get("sessionId") or "default")


def frame_input_bytes(frame):
    input_path = frame.get("inputPath")
    if isinstance(input_path, str) and input_path:
        path = Path(input_path)
        if path.is_file():
            return path.read_bytes()
    data_url = frame.get("dataUrl") or frame.get("frameDataUrl")
    if isinstance(data_url, str) and "," in data_url:
        return base64.b64decode(data_url.split(",", 1)[1])
    raise ValueError("video input no disponible.")


def audio_input_bytes(audio):
    input_path = audio.get("inputPath")
    if isinstance(input_path, str) and input_path:
        path = Path(input_path)
        if path.is_file():
            return path.read_bytes()
    encoded = audio.get("audioDataBase64")
    if isinstance(encoded, str) and encoded:
        return base64.b64decode(encoded)
    raise ValueError("audio input no disponible.")


def process_video_frame_inproc(
    payload,
    frame,
    identity,
    background,
    enabled,
    width,
    height,
    fps,
    sequence,
    started,
    processor="shape-inproc-endpoint-server",
):
    runtime = engines_pkg.get_inproc_runtime()
    session_id = session_id_from_payload(payload)
    input_bgr = engines_pkg.runtime.decode_image_bgr(frame_input_bytes(frame))
    result = runtime.process_frame(session_id, input_bgr, identity, background, enabled)

    output_data_url = engines_pkg.runtime.bgr_to_data_url(result["output"])
    output_path = frame.get("outputPath")
    if isinstance(output_path, str) and output_path:
        try:
            write_data_url(output_data_url, output_path)
        except Exception:
            pass

    applied = [stage["id"] for stage in result["stages"] if stage["changed"]]
    warnings = list(result["warnings"])
    if applied:
        warnings.insert(0, "video_frame_inproc_chain:" + "+".join(applied))

    vram_mb = max(
        [safe_int(stage.get("vramMb")) or 0 for stage in result["stages"]] + [0]
    )
    latency_ms = elapsed_ms(started)
    update_state(latency_ms, warnings[0] if warnings else None)
    return {
        "sequence": sequence,
        "status": result["status"],
        "processor": processor,
        "frame": {
            "dataUrl": output_data_url,
            "width": width,
            "height": height,
            "format": data_url_mime_type(output_data_url),
        },
        "metrics": {
            "latencyMs": latency_ms,
            "fps": fps,
            "vramMb": vram_mb or (safe_int(os.environ.get("SHAPE_MODEL_ENDPOINT_VRAM_MB")) or 0),
            "resolution": f"{width}x{height}",
        },
        "warnings": warnings,
        "stages": result["stages"],
    }


def process_voice_inproc(payload, audio, identity, sample_rate, channels, audio_format, sequence, started):
    runtime = engines_pkg.get_inproc_runtime()
    session_id = session_id_from_payload(payload)
    audio_bytes = audio_input_bytes(audio)
    result = runtime.process_audio(
        session_id, audio_bytes, identity, sample_rate, channels, audio_format, {"voice": True}
    )

    output_base64 = base64.b64encode(result["output"]).decode("ascii")
    output_path = audio.get("outputPath")
    if isinstance(output_path, str) and output_path:
        try:
            write_base64(output_base64, output_path)
        except Exception:
            pass

    warnings = list(result["warnings"])
    if result["status"] == "processed":
        warnings.insert(0, "voice_inproc_processed")
    latency_ms = elapsed_ms(started)
    update_state(latency_ms, warnings[0] if warnings else None)
    return {
        "sequence": sequence,
        "status": result["status"],
        "processor": "shape-voice-inproc-endpoint-server",
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
        "stages": result["stages"],
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

    if inproc_enabled():
        return process_voice_inproc(
            payload, audio, identity, sample_rate, channels, audio_format, sequence, started
        )

    with tempfile.TemporaryDirectory(prefix="shape-model-voice-") as workdir:
        input_path = resolve_audio_input(
            audio.get("inputPath"),
            audio.get("audioDataBase64"),
            Path(workdir) / f"input.{audio_extension(audio_format)}",
        )
        output_path = resolve_output_path(
            audio.get("outputPath"), Path(workdir) / f"output.{audio_extension(audio_format)}"
        )

        if passthrough_enabled():
            copy_file(input_path, output_path)
            warnings.append("voice_endpoint_passthrough")
            output_base64 = file_to_base64(output_path)
        elif demo_effects_enabled():
            demo_audio = demo_audio_payload(
                file_to_base64(input_path),
                sample_rate,
                channels,
                audio_format,
                sequence,
            )
            write_base64(demo_audio["audioDataBase64"], output_path)
            warnings.extend(demo_audio["warnings"])
            output_base64 = demo_audio["audioDataBase64"]
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
        identity_path = identity_path_for_stage(identity, "face")
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
    args = [
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
        identity_path_for_stage(identity, "voice") or "",
    ]
    if isinstance(identity, dict):
        if identity.get("voiceModelPath"):
            args.extend(["--voice-model", str(identity["voiceModelPath"])])
        if identity.get("voiceIndexPath"):
            args.extend(["--voice-index", str(identity["voiceIndexPath"])])
        if identity.get("voiceConfigPath"):
            args.extend(["--voice-config", str(identity["voiceConfigPath"])])
    run_checked(args, "voice wrapper")


def identity_path_for_stage(identity, stage):
    if not isinstance(identity, dict):
        return ""
    if stage == "face":
        return identity.get("faceSourcePath") or identity.get("localArtifactPath") or identity.get("cachedArtifactUri") or identity.get("artifactUri") or ""
    if stage == "voice":
        return identity.get("voiceModelPath") or identity.get("localArtifactPath") or identity.get("cachedArtifactUri") or identity.get("artifactUri") or ""
    return identity.get("localArtifactPath") or identity.get("cachedArtifactUri") or identity.get("artifactUri") or ""


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


def demo_video_data_url(stage, payload, frame, identity, background, width, height, sequence):
    enabled = payload.get("enabled") if isinstance(payload.get("enabled"), dict) else {}
    clean_plate = background.get("cleanPlate") if isinstance(background.get("cleanPlate"), dict) else {}
    identity_label = identity.get("version") or identity.get("id") or "identidad local"
    effects = [
        label
        for enabled_flag, label in (
            (enabled.get("face") or stage == "face", "rostro"),
            (enabled.get("background") or stage == "background", "fondo"),
            (enabled.get("voice"), "voz"),
        )
        if enabled_flag
    ]
    effect_label = " + ".join(effects) if effects else stage
    plate_label = "clean plate" if clean_plate.get("ready") or clean_plate.get("dataUrl") or background.get("cleanPlatePath") else "sin clean plate"
    frame_data_url = frame.get("dataUrl") or frame.get("frameDataUrl") or ""
    safe_frame = html.escape(str(frame_data_url), quote=True)
    safe_identity = html.escape(str(identity_label), quote=True)
    safe_effects = html.escape(effect_label, quote=True)
    safe_stage = html.escape(stage, quote=True)
    safe_plate = html.escape(plate_label, quote=True)
    safe_resolution = html.escape(f"{width}x{height}", quote=True)
    pulse_x = 58 + (sequence % 18) * 6
    accent = "#2563eb" if stage == "face" else "#14b8a6"

    svg = f"""
<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">
  <defs>
    <linearGradient id="shape-demo-glow" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="{accent}" stop-opacity="0.22"/>
      <stop offset="0.62" stop-color="#0f172a" stop-opacity="0.12"/>
      <stop offset="1" stop-color="#111827" stop-opacity="0.20"/>
    </linearGradient>
  </defs>
  <rect width="{width}" height="{height}" fill="#0f172a"/>
  <image href="{safe_frame}" width="{width}" height="{height}" preserveAspectRatio="xMidYMid slice"/>
  <rect width="{width}" height="{height}" fill="url(#shape-demo-glow)"/>
  <ellipse cx="{int(width * 0.5)}" cy="{int(height * 0.42)}" rx="{int(width * 0.18)}" ry="{int(height * 0.27)}" fill="none" stroke="{accent}" stroke-width="5" stroke-opacity="0.78"/>
  <rect x="28" y="28" width="324" height="94" rx="14" fill="#020617" fill-opacity="0.74"/>
  <circle cx="{pulse_x}" cy="75" r="12" fill="#22c55e"/>
  <text x="86" y="66" fill="#ffffff" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="700">Endpoint IA</text>
  <text x="86" y="95" fill="#bfdbfe" font-family="Inter, Arial, sans-serif" font-size="14">{safe_stage} · {safe_effects}</text>
  <rect x="28" y="{height - 116}" width="{width - 56}" height="88" rx="16" fill="#020617" fill-opacity="0.74"/>
  <text x="56" y="{height - 74}" fill="#ffffff" font-family="Inter, Arial, sans-serif" font-size="20" font-weight="700">{safe_identity}</text>
  <text x="56" y="{height - 44}" fill="#cbd5e1" font-family="Inter, Arial, sans-serif" font-size="14">{safe_resolution} · {safe_plate} · frame {sequence}</text>
</svg>
""".strip()
    encoded = base64.b64encode(svg.encode("utf-8")).decode("ascii")
    return f"data:image/svg+xml;base64,{encoded}"


def demo_audio_payload(input_base64, sample_rate, channels, audio_format, sequence):
    try:
        raw = base64.b64decode(input_base64)
    except Exception:
        return {
            "audioDataBase64": input_base64,
            "warnings": ["voice_endpoint_demo_decode_failed"],
        }

    normalized = str(audio_format or "pcm_f32le").lower()
    channels = max(1, min(2, safe_int(channels) or 1))
    sample_rate = max(8000, safe_int(sample_rate) or 48000)

    if normalized in {"pcm_f32le", "f32le", "float32"}:
        output = demo_audio_f32(raw, sample_rate, channels, sequence)
    elif normalized in {"pcm_s16le", "s16le", "int16"}:
        output = demo_audio_s16(raw, sample_rate, channels, sequence)
    elif normalized in {"uint8-time-domain", "u8"}:
        output = demo_audio_u8(raw, sample_rate, channels, sequence)
    else:
        return {
            "audioDataBase64": input_base64,
            "warnings": [f"voice_endpoint_demo_unsupported_format:{normalized}"],
        }

    if output is None:
        return {
            "audioDataBase64": input_base64,
            "warnings": ["voice_endpoint_demo_empty_payload"],
        }

    return {
        "audioDataBase64": base64.b64encode(output).decode("ascii"),
        "warnings": ["voice_endpoint_demo_effect"],
    }


def demo_audio_f32(raw, sample_rate, channels, sequence):
    frame_count = len(raw) // (4 * channels)
    if frame_count <= 0:
        return None

    output = bytearray(frame_count * channels * 4)
    previous = [0.0 for _ in range(channels)]

    for frame_index in range(frame_count):
        mod = demo_audio_modulator(frame_index, sample_rate, sequence)
        for channel in range(channels):
            offset = (frame_index * channels + channel) * 4
            sample = struct.unpack_from("<f", raw, offset)[0]
            processed = demo_audio_sample(sample, previous[channel], mod)
            previous[channel] = processed
            struct.pack_into("<f", output, offset, processed)

    return bytes(output)


def demo_audio_s16(raw, sample_rate, channels, sequence):
    frame_count = len(raw) // (2 * channels)
    if frame_count <= 0:
        return None

    output = bytearray(frame_count * channels * 2)
    previous = [0.0 for _ in range(channels)]

    for frame_index in range(frame_count):
        mod = demo_audio_modulator(frame_index, sample_rate, sequence)
        for channel in range(channels):
            offset = (frame_index * channels + channel) * 2
            sample = struct.unpack_from("<h", raw, offset)[0] / 32768.0
            processed = demo_audio_sample(sample, previous[channel], mod)
            previous[channel] = processed
            struct.pack_into(
                "<h",
                output,
                offset,
                int(max(-1.0, min(0.999969, processed)) * 32768),
            )

    return bytes(output)


def demo_audio_u8(raw, sample_rate, channels, sequence):
    frame_count = len(raw) // channels
    if frame_count <= 0:
        return None

    output = bytearray(frame_count * channels)
    previous = [0.0 for _ in range(channels)]

    for frame_index in range(frame_count):
        mod = demo_audio_modulator(frame_index, sample_rate, sequence)
        for channel in range(channels):
            offset = frame_index * channels + channel
            sample = (raw[offset] - 128) / 128.0
            processed = demo_audio_sample(sample, previous[channel], mod)
            previous[channel] = processed
            output[offset] = max(0, min(255, int(processed * 128 + 128)))

    return bytes(output)


def demo_audio_modulator(frame_index, sample_rate, sequence):
    phase_frame = frame_index + sequence * 2048
    slow = math.sin(2 * math.pi * 38 * phase_frame / sample_rate)
    robot = math.sin(2 * math.pi * 92 * phase_frame / sample_rate)
    return 0.72 + 0.18 * robot + 0.10 * slow


def demo_audio_sample(sample, previous, mod):
    shaped = math.tanh((sample * mod + previous * 0.18) * 1.35)
    return max(-1.0, min(1.0, shaped))


def write_data_url(data_url, path):
    try:
        _, encoded = data_url.split(",", 1)
    except ValueError as error:
        raise ValueError("invalid_data_url") from error

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(base64.b64decode(encoded))


def write_base64(encoded, path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(base64.b64decode(encoded))


def file_to_data_url(path, mime_type):
    return f"data:{mime_type};base64,{file_to_base64(path)}"


def file_to_image_data_url(path):
    return file_to_data_url(path, image_mime_type(path))


def image_mime_type(path):
    data = Path(path).read_bytes()[:96]
    stripped = data.lstrip()
    if data.startswith(b"\xff\xd8"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if stripped.startswith(b"<svg"):
        return "image/svg+xml"

    suffix = Path(path).suffix.lower()
    if suffix == ".png":
        return "image/png"
    if suffix == ".webp":
        return "image/webp"
    if suffix == ".svg":
        return "image/svg+xml"
    return "image/jpeg"


def data_url_mime_type(data_url):
    if not isinstance(data_url, str) or not data_url.startswith("data:"):
        return "image/jpeg"
    return data_url[5:].split(";", 1)[0].split(",", 1)[0] or "image/jpeg"


def diagnostics_payload():
    if inproc_enabled():
        return inproc_diagnostics_payload()

    stages = endpoint_stage_diagnostics()
    return {
        "ready": all(stage["ready"] for stage in stages),
        "mode": endpoint_mode(),
        "startedAt": STATE["startedAt"],
        "requests": STATE["requests"],
        "lastLatencyMs": STATE["lastLatencyMs"],
        "lastWarning": STATE["lastWarning"],
        "stageStatus": {
            stage["id"]: stage["status"]
            for stage in stages
        },
        "runtime": {
            "python": sys.executable,
            "wrapperPython": wrapper_python(),
            "wrapperPythonAvailable": command_available_status(wrapper_python()),
            "repoRoot": str(repo_root()),
            "wrapperRoot": str(repo_root() / "apps" / "ai-sidecar" / "wrappers"),
            "timeoutSeconds": model_timeout(),
            "maxBodyBytes": MAX_BODY_BYTES,
        },
        "configuration": {
            "passthrough": passthrough_enabled(),
            "demoEffects": demo_effects_enabled(),
            "accessLog": access_log_enabled(),
            "vramMb": safe_int(os.environ.get("SHAPE_MODEL_ENDPOINT_VRAM_MB")) or 0,
        },
        "stages": stages,
    }


def inproc_diagnostics_payload():
    runtime = engines_pkg.get_inproc_runtime()
    runtime.ensure_loaded()
    health = runtime.health()
    engines_health = health.get("engines", {})
    load_reports = health.get("loadReports", {})

    def stage_entry(stage_id, label, kind, engine_state, load_report):
        state = engine_state.get("state")
        ready = state in {"active", "degraded"}
        status = "ready" if state == "active" else ("degraded" if state == "degraded" else "error")
        issues = [] if ready else [engine_state.get("detail") or engine_state.get("reason") or "engine no cargado"]
        warnings = list((load_report or {}).get("warnings", [])) if isinstance(load_report, dict) else []
        return {
            "id": stage_id,
            "label": label,
            "kind": kind,
            "ready": ready,
            "status": status,
            "mode": "inproc",
            "engine": engine_state,
            "loadReport": load_report,
            "issues": issues,
            "warnings": warnings,
        }

    face = stage_entry("face", "Face swap", "video", engines_health.get("face", {}), load_reports.get("face"))
    background = stage_entry(
        "background", "Background matting", "video", engines_health.get("background", {}), load_reports.get("background")
    )
    voice = stage_entry("voice", "Cambio de voz", "audio", engines_health.get("voice", {}), load_reports.get("voice"))

    video_ready = face["ready"] and background["ready"]
    video = {
        "id": "video-frame",
        "label": "Video frame",
        "kind": "video",
        "ready": video_ready,
        "status": "ready" if video_ready else "limited",
        "mode": "inproc",
        "engine": {
            "state": _worse_state(face["engine"].get("state"), background["engine"].get("state")),
            "device": health.get("device"),
        },
        "issues": [*[f"face: {issue}" for issue in face["issues"]], *[f"background: {issue}" for issue in background["issues"]]],
        "warnings": [],
    }

    stages = [video, face, background, voice]
    return {
        "ready": video_ready,
        "mode": "inproc",
        "startedAt": STATE["startedAt"],
        "requests": STATE["requests"],
        "lastLatencyMs": STATE["lastLatencyMs"],
        "lastWarning": STATE["lastWarning"],
        "stageStatus": {stage["id"]: stage["status"] for stage in stages},
        "runtime": {
            "python": sys.executable,
            "engine": "inproc",
            "device": health.get("device"),
            "backgroundEngine": health.get("backgroundEngine"),
            "loaded": health.get("loaded"),
            "capabilities": health.get("capabilities"),
            "loadTimeoutSeconds": engines_pkg.load_timeout_seconds(),
            "repoRoot": str(repo_root()),
            "maxBodyBytes": MAX_BODY_BYTES,
        },
        "configuration": {
            "engine": "inproc",
            "passthrough": False,
            "demoEffects": False,
            "accessLog": access_log_enabled(),
            "backgroundEngine": health.get("backgroundEngine"),
            "vramMb": safe_int(os.environ.get("SHAPE_MODEL_ENDPOINT_VRAM_MB")) or 0,
        },
        "loadReport": load_reports,
        "stages": stages,
    }


def _worse_state(*states):
    order = {"failed": 0, "degraded": 1, "active": 2, None: 3}
    present = [s for s in states if s is not None]
    if not present:
        return "failed"
    return min(present, key=lambda s: order.get(s, 3))


def endpoint_stage_diagnostics():
    face = wrapper_stage_diagnostics(
        "face",
        "Face swap",
        "facefusion_frame.py",
        facefusion_requirements(),
    )
    background = wrapper_stage_diagnostics(
        "background",
        "Background matting",
        "backgroundmattingv2_frame.py",
        background_requirements(),
    )
    voice = wrapper_stage_diagnostics(
        "voice",
        "Cambio de voz",
        "vcclient000_chunk.py",
        voice_requirements(),
    )
    video_ready = face["ready"] and background["ready"]
    video_issues = [
        *[f"face: {issue}" for issue in face["issues"]],
        *[f"background: {issue}" for issue in background["issues"]],
    ]
    video_warnings = [
        *[f"face: {warning}" for warning in face["warnings"]],
        *[f"background: {warning}" for warning in background["warnings"]],
    ]

    return [
        {
            "id": "video-frame",
            "label": "Video frame",
            "kind": "video",
            "ready": video_ready,
            "status": "ready" if video_ready else "limited",
            "mode": endpoint_mode(),
            "wrappers": ["facefusion_frame.py", "backgroundmattingv2_frame.py"],
            "issues": video_issues,
            "warnings": video_warnings,
        },
        face,
        background,
        voice,
    ]


def wrapper_stage_diagnostics(stage_id, label, file_name, requirements):
    wrapper = wrapper_path(file_name)
    issues = []
    warnings = []

    if not wrapper.exists():
        issues.append(f"wrapper no existe: {wrapper}")

    python_status = command_available_status(wrapper_python())
    if python_status == "missing":
        issues.append(f"python wrapper no disponible: {wrapper_python()}")

    if passthrough_enabled():
        warnings.append("passthrough activo; no valida modelo real.")
    elif demo_effects_enabled():
        warnings.append("preset local activo; no valida modelo real.")
    else:
        issues.extend(requirements["issues"])
        warnings.extend(requirements["warnings"])

    ready = len(issues) == 0
    return {
        "id": stage_id,
        "label": label,
        "kind": "audio" if stage_id == "voice" else "video",
        "ready": ready,
        "status": "ready" if ready else "error",
        "mode": endpoint_mode(),
        "wrapper": str(wrapper),
        "wrapperExists": wrapper.exists(),
        "wrapperPython": wrapper_python(),
        "wrapperPythonAvailable": python_status,
        "issues": issues,
        "warnings": warnings,
        "requirements": requirements["summary"],
    }


def facefusion_requirements():
    summary = {
        "commandTemplate": bool(env_non_empty("FACEFUSION_COMMAND_TEMPLATE")),
        "facefusionDir": env_non_empty("FACEFUSION_DIR"),
        "entrypoint": env_non_empty("FACEFUSION_ENTRYPOINT") or "facefusion.py",
        "python": env_non_empty("FACEFUSION_PYTHON") or "python",
        "executionProviders": env_non_empty("FACEFUSION_EXECUTION_PROVIDERS") or "cuda",
    }
    issues = []
    warnings = []

    if summary["commandTemplate"]:
        return {"summary": summary, "issues": issues, "warnings": warnings}

    entrypoint = facefusion_entrypoint_path(summary)
    if not entrypoint:
        issues.append("FACEFUSION_DIR no configurado y FACEFUSION_COMMAND_TEMPLATE vacío.")
    elif not entrypoint.exists():
        issues.append(f"FaceFusion entrypoint no existe: {entrypoint}")

    if command_available_status(str(summary["python"])) == "missing":
        issues.append(f"FACEFUSION_PYTHON no disponible: {summary['python']}")

    if "cuda" in str(summary["executionProviders"]).lower() and not shutil.which("nvidia-smi"):
        warnings.append("FACEFUSION_EXECUTION_PROVIDERS usa cuda sin nvidia-smi detectable.")

    return {"summary": summary, "issues": issues, "warnings": warnings}


def background_requirements():
    summary = {
        "commandTemplate": bool(env_non_empty("BMV2_COMMAND_TEMPLATE")),
        "repoDir": env_non_empty("BMV2_REPO_DIR"),
        "python": env_non_empty("BMV2_PYTHON") or "python",
        "checkpoint": env_non_empty("BMV2_MODEL_CHECKPOINT"),
        "device": env_non_empty("BMV2_DEVICE") or "cuda",
    }
    issues = []
    warnings = []

    if summary["commandTemplate"]:
        return {"summary": summary, "issues": issues, "warnings": warnings}

    repo_dir = Path(summary["repoDir"]) if summary["repoDir"] else None
    if not repo_dir or not (repo_dir / "inference_images.py").exists():
        issues.append("BMV2_REPO_DIR no contiene inference_images.py.")

    checkpoint = Path(summary["checkpoint"]) if summary["checkpoint"] else None
    if not checkpoint or not checkpoint.exists():
        issues.append("BMV2_MODEL_CHECKPOINT no existe o está vacío.")

    if command_available_status(str(summary["python"])) == "missing":
        issues.append(f"BMV2_PYTHON no disponible: {summary['python']}")

    if str(summary["device"]).lower() == "cuda" and not shutil.which("nvidia-smi"):
        warnings.append("BMV2_DEVICE=cuda sin nvidia-smi detectable.")

    return {"summary": summary, "issues": issues, "warnings": warnings}


def voice_requirements():
    summary = {
        "chunkCommand": env_non_empty("VCCLIENT000_CHUNK_COMMAND"),
        "httpEndpoint": env_non_empty("VCCLIENT000_HTTP_ENDPOINT"),
        "httpMode": env_non_empty("VCCLIENT000_HTTP_MODE") or "auto",
    }
    issues = []
    warnings = []

    if not summary["chunkCommand"] and not summary["httpEndpoint"]:
        issues.append("Configura VCCLIENT000_CHUNK_COMMAND o VCCLIENT000_HTTP_ENDPOINT.")

    if summary["chunkCommand"]:
        command_status = command_available_status(summary["chunkCommand"])
        if command_status == "missing":
            warnings.append("VCCLIENT000_CHUNK_COMMAND configurado, pero el ejecutable inicial no se detectó.")

    return {"summary": summary, "issues": issues, "warnings": warnings}


def facefusion_entrypoint_path(summary):
    facefusion_dir = summary["facefusionDir"]
    entrypoint = Path(str(summary["entrypoint"]))
    if facefusion_dir and not entrypoint.is_absolute():
        entrypoint = Path(facefusion_dir) / entrypoint
    return entrypoint if facefusion_dir or entrypoint.is_absolute() else None


def command_available_status(command):
    if not command:
        return "not-configured"

    try:
        executable = shlex.split(str(command), posix=os.name != "nt")[0]
    except (ValueError, IndexError):
        executable = str(command).split()[0] if str(command).split() else ""

    if not executable:
        return "not-configured"

    if Path(executable).exists() or shutil.which(executable):
        return "available"

    return "missing"


def endpoint_mode():
    return engines_pkg.engine_mode()


def env_non_empty(name):
    value = os.environ.get(name)
    if value is None:
        return None
    value = value.strip()
    return value or None


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
    parser.add_argument("--engine", default=None, help="Engine mode: inproc|wrappers|passthrough|demo-effects.")
    args = parser.parse_args()

    if args.engine:
        os.environ["SHAPE_MODEL_ENDPOINT_ENGINE"] = args.engine
    if args.passthrough:
        os.environ["SHAPE_MODEL_ENDPOINT_PASSTHROUGH"] = "true"
    if args.demo_effects:
        os.environ["SHAPE_MODEL_ENDPOINT_DEMO_EFFECTS"] = "true"

    STATE["startedAt"] = datetime.now(timezone.utc).isoformat()

    if endpoint_mode() == "inproc":
        # Load the resident engines once at startup (in a background thread so
        # the socket comes up immediately); /health reports "limited" until the
        # models finish loading, "ready" afterwards.
        def _warmup_engines():
            try:
                engines_pkg.get_inproc_runtime().warmup(engines_pkg.load_timeout_seconds())
            except Exception as error:  # pragma: no cover - defensive
                print(f"[shape-model-endpoint] fallo al cargar motores inproc: {error}")

        threading.Thread(target=_warmup_engines, daemon=True).start()

    server = ThreadingHTTPServer((args.host, args.port), ShapeModelEndpointHandler)
    print(f"[shape-model-endpoint] listening on http://{args.host}:{args.port} (engine={endpoint_mode()})")
    server.serve_forever()


if __name__ == "__main__":
    main()
