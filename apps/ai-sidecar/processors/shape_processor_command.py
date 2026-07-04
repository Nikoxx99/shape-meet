#!/usr/bin/env python3
import argparse
import base64
import html
import json
import math
import os
import platform
import shlex
import struct
import subprocess
import tempfile
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib import error as urllib_error
from urllib.parse import quote
from urllib import request as urllib_request


DEFAULT_VIDEO_PORT = 7860
DEFAULT_AUDIO_PORT = 7861
MAX_BODY_BYTES = 10 * 1024 * 1024
COMMAND_DETAIL_LIMIT = 600
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
        endpoint = any_model_endpoint_configured(kind)
        demo_effects = demo_effects_enabled()
        self._json(
            {
                "status": "ready" if command or endpoint or demo_effects else "limited",
                "kind": kind,
                "mode": "command"
                if command
                else "endpoint"
                if endpoint
                else "demo-effects"
                if demo_effects
                else "passthrough",
                "commandConfigured": bool(command),
                "endpointConfigured": bool(endpoint),
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
        endpoint = combined_model_endpoint("video")
        stage_adapters = video_stage_adapters(enabled) if not command and not endpoint else []
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
                        "sequence": str(sequence),
                        "stage": "video",
                    },
                    {
                        **command_context_env("video", payload, sequence, "video"),
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
                    status = "error"
                else:
                    status = "error"
        elif endpoint:
            with tempfile.TemporaryDirectory(prefix="shape-video-") as workdir:
                input_path = os.path.join(workdir, "input.jpg")
                output_path = os.path.join(workdir, "output.jpg")
                clean_plate_path = write_clean_plate(background, workdir)
                write_data_url(input_data_url, input_path)

                result = call_video_endpoint(
                    endpoint,
                    payload,
                    "video",
                    input_data_url,
                    input_path,
                    output_path,
                    clean_plate_path,
                    identity,
                    width,
                    height,
                    fps,
                    sequence,
                )
                warnings.extend(result["warnings"])

                if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
                    output_data_url = file_to_data_url(output_path, "image/jpeg")
                    status = "processed"
                    processor = "shape-video-endpoint-adapter"
                elif result["ok"]:
                    warnings.append("video_endpoint_output_missing")
                    status = "error"
                else:
                    status = "error"
        elif stage_adapters:
            with tempfile.TemporaryDirectory(prefix="shape-video-") as workdir:
                input_path = os.path.join(workdir, "input.jpg")
                clean_plate_path = write_clean_plate(background, workdir)
                write_data_url(input_data_url, input_path)
                current_input_path = input_path
                completed_stages = []
                stage_failed = False

                for stage, stage_command, stage_endpoint in stage_adapters:
                    output_path = os.path.join(workdir, f"output-{stage}.jpg")
                    if stage_command:
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
                                "sequence": str(sequence),
                                "stage": stage,
                            },
                            {
                                **command_context_env("video", payload, sequence, stage),
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
                    else:
                        result = call_video_endpoint(
                            stage_endpoint,
                            payload,
                            stage,
                            file_to_data_url(current_input_path, "image/jpeg"),
                            current_input_path,
                            output_path,
                            clean_plate_path,
                            identity,
                            width,
                            height,
                            fps,
                            sequence,
                        )
                    warnings.extend(prefix_warnings(stage, result["warnings"]))

                    if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
                        current_input_path = output_path
                        completed_stages.append(stage)
                        continue

                    if result["ok"]:
                        warnings.append(f"{stage}_model_output_missing")
                    stage_failed = True
                    break

                if completed_stages:
                    output_data_url = file_to_data_url(current_input_path, "image/jpeg")
                    status = "error" if stage_failed else "processed"
                    processor = "shape-video-model-chain:" + "+".join(completed_stages)
                elif stage_failed:
                    status = "error"
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
        combined_command = combined_model_command("audio")
        combined_endpoint = combined_model_endpoint("audio")
        command = combined_command or voice_stage_command(enabled)
        endpoint = None if command else combined_endpoint or voice_stage_endpoint(enabled)
        if command:
            with tempfile.TemporaryDirectory(prefix="shape-audio-") as workdir:
                input_path = os.path.join(workdir, f"input.{audio_extension(audio_format)}")
                output_path = os.path.join(workdir, f"output.{audio_extension(audio_format)}")
                write_base64(input_base64, input_path)
                command_stage = "audio" if combined_command else "voice"

                result = run_model_command(
                    command,
                    {
                        "input": input_path,
                        "output": output_path,
                        "sample_rate": str(sample_rate),
                        "channels": str(channels),
                        "format": audio_format,
                        "session_id": session_id(payload),
                        "sequence": str(sequence),
                        "stage": command_stage,
                        "identity": identity.get("localArtifactPath") or identity.get("cachedArtifactUri") or identity.get("artifactUri") or "",
                    },
                    {
                        **command_context_env("audio", payload, sequence, command_stage),
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
                    if not combined_command:
                        processor = "shape-voice-command-adapter"
                elif result["ok"]:
                    warnings.append("audio_model_output_missing")
                    status = "error"
                else:
                    status = "error"
        elif endpoint:
            with tempfile.TemporaryDirectory(prefix="shape-audio-") as workdir:
                input_path = os.path.join(workdir, f"input.{audio_extension(audio_format)}")
                output_path = os.path.join(workdir, f"output.{audio_extension(audio_format)}")
                write_base64(input_base64, input_path)
                command_stage = "audio" if combined_endpoint else "voice"

                result = call_audio_endpoint(
                    endpoint,
                    payload,
                    command_stage,
                    input_base64,
                    input_path,
                    output_path,
                    identity,
                    sample_rate,
                    channels,
                    audio_format,
                    sequence,
                )
                warnings.extend(result["warnings"])

                if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
                    output_base64 = file_to_base64(output_path)
                    status = "processed"
                    processor = "shape-audio-endpoint-adapter" if combined_endpoint else "shape-voice-endpoint-adapter"
                elif result["ok"]:
                    warnings.append("audio_endpoint_output_missing")
                    status = "error"
                else:
                    status = "error"
        elif demo_effects_enabled():
            demo_audio = demo_audio_payload(
                input_base64,
                sample_rate,
                channels,
                audio_format,
                sequence,
            )
            output_base64 = demo_audio["audioDataBase64"]
            status = "processed"
            processor = "shape-demo-audio-processor"
            warnings.extend(demo_audio["warnings"])

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
    except subprocess.TimeoutExpired as error:
        detail = command_output_detail(error.stdout, error.stderr)
        warning = "model_command_timeout"
        if detail:
            warning = f"{warning}:{detail}"
        return {"ok": False, "warnings": [warning]}
    except Exception as error:
        return {"ok": False, "warnings": [f"model_command_error:{str(error)[:COMMAND_DETAIL_LIMIT]}"]}

    if result.returncode == 0:
        return {"ok": True, "warnings": command_warnings(result)}

    detail = command_output_detail(result.stdout, result.stderr)
    warning = f"model_command_failed:{result.returncode}"
    if detail:
        warning = f"{warning}:{detail}"
    return {"ok": False, "warnings": [warning]}


def call_video_endpoint(
    endpoint,
    payload,
    stage,
    input_data_url,
    input_path,
    output_path,
    clean_plate_path,
    identity,
    width,
    height,
    fps,
    sequence,
):
    response = post_model_endpoint(
        endpoint,
        {
            "stage": stage,
            "session": payload.get("session") if isinstance(payload.get("session"), dict) else {},
            "sequence": sequence,
            "frame": {
                **(payload.get("frame") if isinstance(payload.get("frame"), dict) else {}),
                "dataUrl": input_data_url,
                "frameDataUrl": input_data_url,
                "inputPath": input_path,
                "outputPath": output_path,
                "width": width,
                "height": height,
                "format": "image/jpeg",
            },
            "identity": identity,
            "background": {
                **(payload.get("background") if isinstance(payload.get("background"), dict) else {}),
                "cleanPlatePath": clean_plate_path or "",
            },
            "enabled": payload.get("enabled") if isinstance(payload.get("enabled"), dict) else {},
            "target": {
                **(payload.get("target") if isinstance(payload.get("target"), dict) else {}),
                "width": width,
                "height": height,
                "fps": fps,
            },
        },
        "video_endpoint",
    )
    if not response["ok"]:
        return response

    data_url = extract_frame_data_url(response["data"])
    if data_url:
        write_data_url(data_url, output_path)
    if endpoint_status(response["data"]) == "error":
        response["warnings"].append("video_endpoint_error_status")
        response["ok"] = False
    return response


def call_audio_endpoint(
    endpoint,
    payload,
    stage,
    input_base64,
    input_path,
    output_path,
    identity,
    sample_rate,
    channels,
    audio_format,
    sequence,
):
    response = post_model_endpoint(
        endpoint,
        {
            "stage": stage,
            "session": payload.get("session") if isinstance(payload.get("session"), dict) else {},
            "sequence": sequence,
            "audio": {
                **(payload.get("audio") if isinstance(payload.get("audio"), dict) else {}),
                "audioDataBase64": input_base64,
                "inputPath": input_path,
                "outputPath": output_path,
                "sampleRate": sample_rate,
                "channels": channels,
                "format": audio_format,
            },
            "identity": identity,
            "enabled": payload.get("enabled") if isinstance(payload.get("enabled"), dict) else {},
        },
        "audio_endpoint",
    )
    if not response["ok"]:
        return response

    encoded = extract_audio_base64(response["data"])
    if encoded:
        write_base64(encoded, output_path)
    if endpoint_status(response["data"]) == "error":
        response["warnings"].append("audio_endpoint_error_status")
        response["ok"] = False
    return response


def post_model_endpoint(endpoint, payload, label):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib_request.Request(
        endpoint,
        data=body,
        headers={"content-type": "application/json", "accept": "application/json"},
        method="POST",
    )

    try:
        with urllib_request.urlopen(request, timeout=model_timeout()) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib_error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:COMMAND_DETAIL_LIMIT]
        return {"ok": False, "warnings": [f"{label}_http_error:{error.code}:{detail}"], "data": {}}
    except json.JSONDecodeError as error:
        return {"ok": False, "warnings": [f"{label}_invalid_json:{str(error)[:COMMAND_DETAIL_LIMIT]}"], "data": {}}
    except Exception as error:
        return {"ok": False, "warnings": [f"{label}_error:{str(error)[:COMMAND_DETAIL_LIMIT]}"], "data": {}}

    return {"ok": True, "warnings": endpoint_warnings(data), "data": data}


def endpoint_warnings(data):
    values = []
    if isinstance(data, dict):
        values.extend(data.get("warnings") if isinstance(data.get("warnings"), list) else [])
        frame = data.get("frame")
        if isinstance(frame, dict):
            values.extend(frame.get("warnings") if isinstance(frame.get("warnings"), list) else [])
        audio = data.get("audio")
        if isinstance(audio, dict):
            values.extend(audio.get("warnings") if isinstance(audio.get("warnings"), list) else [])
    return unique_warnings(values)


def endpoint_status(data):
    if not isinstance(data, dict):
        return None
    if isinstance(data.get("status"), str):
        return data.get("status")
    for key in ("frame", "audio"):
        nested = data.get(key)
        if isinstance(nested, dict) and isinstance(nested.get("status"), str):
            return nested.get("status")
    return None


def extract_frame_data_url(data):
    if not isinstance(data, dict):
        return None

    for key in ("dataUrl", "frameDataUrl", "imageDataUrl"):
        value = data.get(key)
        if isinstance(value, str) and value.startswith("data:image/"):
            return value

    frame = data.get("frame")
    if isinstance(frame, dict):
        for key in ("dataUrl", "frameDataUrl", "imageDataUrl"):
            value = frame.get(key)
            if isinstance(value, str) and value.startswith("data:image/"):
                return value
        nested = frame.get("frame")
        if isinstance(nested, dict):
            for key in ("dataUrl", "frameDataUrl", "imageDataUrl"):
                value = nested.get(key)
                if isinstance(value, str) and value.startswith("data:image/"):
                    return value

    return None


def extract_audio_base64(data):
    if not isinstance(data, dict):
        return None

    value = data.get("audioDataBase64")
    if isinstance(value, str) and value:
        return value

    audio = data.get("audio")
    if isinstance(audio, dict):
        value = audio.get("audioDataBase64")
        if isinstance(value, str) and value:
            return value
        nested = audio.get("audio")
        if isinstance(nested, dict):
            value = nested.get("audioDataBase64")
            if isinstance(value, str) and value:
                return value

    return None


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


def command_context_env(kind, payload, sequence, stage):
    context = {
        "SHAPE_PROCESSOR_KIND": kind,
        "SHAPE_MODEL_STAGE": stage,
        "SHAPE_SESSION_ID": session_id(payload),
        "SHAPE_REQUEST_SEQUENCE": str(sequence),
    }

    if kind == "video":
        context["SHAPE_FRAME_SEQUENCE"] = str(sequence)
    else:
        context["SHAPE_AUDIO_SEQUENCE"] = str(sequence)

    return context


def command_warnings(result):
    warnings = []
    stderr = command_output_detail("", result.stderr, limit=240)
    if stderr:
        warnings.append(f"model_command_stderr:{stderr}")
    return warnings


def command_output_detail(stdout, stderr, limit=COMMAND_DETAIL_LIMIT):
    text = "\n".join(part for part in (normalize_output(stderr), normalize_output(stdout)) if part)
    if not text.strip():
        return ""

    text = " ".join(text.split())
    wrapper_marker = "[shape-wrapper]"
    marker_index = text.rfind(wrapper_marker)
    if marker_index >= 0:
        text = "shape-wrapper: " + text[marker_index + len(wrapper_marker):].strip()

    return text[-limit:]


def normalize_output(value):
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)


def combined_model_command(kind):
    if kind == "audio":
        return env_non_empty("SHAPE_AUDIO_CHUNK_COMMAND")
    return env_non_empty("SHAPE_VIDEO_FRAME_COMMAND")


def combined_model_endpoint(kind):
    if kind == "audio":
        return env_non_empty("SHAPE_AUDIO_CHUNK_ENDPOINT")
    return env_non_empty("SHAPE_VIDEO_FRAME_ENDPOINT")


def any_model_command_configured(kind):
    if combined_model_command(kind):
        return True

    if kind == "audio":
        return bool(env_non_empty("SHAPE_VOICE_COMMAND"))

    return bool(env_non_empty("SHAPE_FACE_COMMAND") or env_non_empty("SHAPE_BACKGROUND_COMMAND"))


def any_model_endpoint_configured(kind):
    if combined_model_endpoint(kind):
        return True

    if kind == "audio":
        return bool(env_non_empty("SHAPE_VOICE_ENDPOINT"))

    return bool(env_non_empty("SHAPE_FACE_ENDPOINT") or env_non_empty("SHAPE_BACKGROUND_ENDPOINT"))


def video_stage_adapters(enabled):
    adapters = []
    if enabled.get("face"):
        command = env_non_empty("SHAPE_FACE_COMMAND")
        endpoint = env_non_empty("SHAPE_FACE_ENDPOINT")
        if command or endpoint:
            adapters.append(("face", command, endpoint))
    if enabled.get("background"):
        command = env_non_empty("SHAPE_BACKGROUND_COMMAND")
        endpoint = env_non_empty("SHAPE_BACKGROUND_ENDPOINT")
        if command or endpoint:
            adapters.append(("background", command, endpoint))
    return adapters


def voice_stage_command(enabled):
    if not enabled.get("voice"):
        return None
    return env_non_empty("SHAPE_VOICE_COMMAND")


def voice_stage_endpoint(enabled):
    if not enabled.get("voice"):
        return None
    return env_non_empty("SHAPE_VOICE_ENDPOINT")


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
    plate_label = (
        "clean plate"
        if clean_plate.get("ready") or clean_plate.get("dataUrl")
        else "sin clean plate"
    )
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


def demo_audio_payload(input_base64, sample_rate, channels, audio_format, sequence):
    try:
        raw = base64.b64decode(input_base64)
    except Exception:
        return {
            "audioDataBase64": input_base64,
            "warnings": ["demo_audio_decode_failed"],
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
            "warnings": [f"demo_audio_unsupported_format:{normalized}"],
        }

    if output is None:
        return {
            "audioDataBase64": input_base64,
            "warnings": ["demo_audio_empty_payload"],
        }

    return {
        "audioDataBase64": base64.b64encode(output).decode("ascii"),
        "warnings": ["demo_audio_voice_effect"],
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
