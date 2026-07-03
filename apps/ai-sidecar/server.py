#!/usr/bin/env python3
import argparse
import atexit
import base64
import json
import logging
import os
import platform
import re
import signal
import shlex
import shutil
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib import error as urllib_error
from urllib import parse as urllib_parse
from urllib import request as urllib_request


PIPELINE_CONFIGS = [
    {
        "id": "face",
        "label": "Rostro",
        "model": "FaceFusion / trained DFM connector",
        "detail": "Adaptador preparado para identidad por foto o modelo entrenado.",
        "enabledEnv": "SHAPE_FACE_ENGINE",
        "commandEnv": "SHAPE_FACE_COMMAND",
        "endpointEnv": "SHAPE_VIDEO_PROCESSOR_ENDPOINT",
        "processor": "video",
    },
    {
        "id": "background",
        "label": "Fondo",
        "model": "BackgroundMattingV2",
        "detail": "Adaptador preparado para matting premium 720p30.",
        "enabledEnv": "SHAPE_BACKGROUND_ENGINE",
        "commandEnv": "SHAPE_BACKGROUND_COMMAND",
        "endpointEnv": "SHAPE_VIDEO_PROCESSOR_ENDPOINT",
        "processor": "video",
    },
    {
        "id": "voice",
        "label": "Voz",
        "model": "vcclient000",
        "detail": "Adaptador preparado para proxy de cambio de voz local.",
        "enabledEnv": "SHAPE_VOICE_ENGINE",
        "commandEnv": "SHAPE_VOICE_COMMAND",
        "endpointEnv": "SHAPE_AUDIO_PROCESSOR_ENDPOINT",
        "processor": "audio",
    },
]

MANAGED_PROCESSOR_CONFIGS = [
    {
        "id": "video",
        "label": "Video",
        "commandEnv": "SHAPE_VIDEO_PROCESSOR_COMMAND",
        "endpointEnv": "SHAPE_VIDEO_PROCESSOR_ENDPOINT",
        "healthUrlEnv": "SHAPE_VIDEO_PROCESSOR_HEALTH_URL",
        "portEnv": "SHAPE_VIDEO_PROCESSOR_PORT",
        "defaultEndpoint": "http://127.0.0.1:7860/process-frame",
    },
    {
        "id": "audio",
        "label": "Audio",
        "commandEnv": "SHAPE_AUDIO_PROCESSOR_COMMAND",
        "endpointEnv": "SHAPE_AUDIO_PROCESSOR_ENDPOINT",
        "healthUrlEnv": "SHAPE_AUDIO_PROCESSOR_HEALTH_URL",
        "portEnv": "SHAPE_AUDIO_PROCESSOR_PORT",
        "defaultEndpoint": "http://127.0.0.1:7861/process-audio",
    },
]

SESSIONS = {}
DEFAULT_WIDTH = 1280
DEFAULT_HEIGHT = 720
DEFAULT_FPS = 30
MAX_FRAME_BYTES = 6 * 1024 * 1024
MAX_AUDIO_BYTES = 2 * 1024 * 1024
EXTERNAL_PROCESSOR_TIMEOUT_SECS = 0.8
MANAGED_PROCESSORS = {}
MANAGED_PROCESSOR_LOG_LIMIT = 60
SENTRY = None
PREFLIGHT_FRAME_DATA_URL = (
    "data:image/jpeg;base64,"
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////"
    "2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/"
    "8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/"
    "9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/"
    "xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Al//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/"
    "EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/"
    "2gAIAQEAAT8QH//Z"
)


class ShapeMeetHandler(BaseHTTPRequestHandler):
    server_version = "ShapeMeetAISidecar/0.1"

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def do_GET(self):
        path = request_path(self.path)

        if path == "/health":
            self._json(
                {
                    "status": "ready",
                    "mode": ai_mode(),
                    "message": health_message(),
                    "checkedAt": datetime.now(timezone.utc).isoformat(),
                    "pipelines": pipelines_for_session(),
                    "diagnostics": diagnostics_summary(),
                }
            )
            return

        if path == "/diagnostics":
            self._json({"diagnostics": diagnostics_payload()})
            return

        if path == "/pipelines":
            self._json({"pipelines": pipelines_for_session()})
            return

        session_match = re.fullmatch(r"/sessions/([a-zA-Z0-9_-]+)", path)
        if session_match:
            session_id = session_match.group(1)
            session = SESSIONS.get(session_id)
            if not session:
                self._json({"error": "session_not_found"}, status=404)
                return
            self._json({"session": session_payload(session)})
            return

        self._json({"error": "not_found"}, status=404)

    def do_POST(self):
        path = request_path(self.path)
        frame_match = re.fullmatch(r"/sessions/([a-zA-Z0-9_-]+)/frames", path)
        if frame_match:
            self._handle_frame(frame_match.group(1))
            return

        audio_match = re.fullmatch(r"/sessions/([a-zA-Z0-9_-]+)/audio", path)
        if audio_match:
            self._handle_audio(audio_match.group(1))
            return

        if path == "/preflight":
            payload = self._read_json()
            if payload is None:
                self._json({"error": "invalid_json"}, status=400)
                return
            self._json({"preflight": run_preflight(payload)})
            return

        if path == "/sessions":
            payload = self._read_json()
            if payload is None:
                self._json({"error": "invalid_json"}, status=400)
                return

            session = session_from_start_payload(payload)
            session["warnings"] = session_warnings(session)
            SESSIONS[session["id"]] = session
            self._json({"session": session_payload(session)}, status=201)
            return

        self._json({"error": "not_found"}, status=404)

    def _handle_frame(self, session_id):
        session = SESSIONS.get(session_id)
        if not session:
            self._json({"error": "session_not_found"}, status=404)
            return

        if session.get("status") != "running":
            self._json({"error": "session_not_running"}, status=409)
            return

        if int(self.headers.get("content-length", "0")) > MAX_FRAME_BYTES:
            self._json({"error": "frame_too_large"}, status=413)
            return

        payload = self._read_json()
        if payload is None:
            self._json({"error": "invalid_json"}, status=400)
            return

        frame_data = payload.get("frameDataUrl")
        if not isinstance(frame_data, str) or not frame_data.startswith("data:image/"):
            self._json({"error": "invalid_frame"}, status=400)
            return

        self._json({"frame": process_frame_for_session(session, payload)})

    def _handle_audio(self, session_id):
        session = SESSIONS.get(session_id)
        if not session:
            self._json({"error": "session_not_found"}, status=404)
            return

        if session.get("status") != "running":
            self._json({"error": "session_not_running"}, status=409)
            return

        if int(self.headers.get("content-length", "0")) > MAX_AUDIO_BYTES:
            self._json({"error": "audio_too_large"}, status=413)
            return

        payload = self._read_json()
        if payload is None:
            self._json({"error": "invalid_json"}, status=400)
            return

        audio_data = payload.get("audioDataBase64")
        if not isinstance(audio_data, str) or not audio_data:
            self._json({"error": "invalid_audio"}, status=400)
            return

        self._json({"audio": process_audio_for_session(session, payload)})

    def do_DELETE(self):
        path = request_path(self.path)
        session_match = re.fullmatch(r"/sessions/([a-zA-Z0-9_-]+)", path)
        if session_match:
            session_id = session_match.group(1)
            session = SESSIONS.get(session_id)
            if not session:
                self._json({"ok": True, "stopped": False})
                return
            session["status"] = "stopped"
            session["updatedAt"] = now_iso()
            self._json({"ok": True, "stopped": True, "session": session_payload(session)})
            return

        self._json({"error": "not_found"}, status=404)

    def log_message(self, format, *args):
        print(f"[shape-ai-sidecar] {self.address_string()} {format % args}")

    def _json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._cors_headers()
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _cors_headers(self):
        self.send_header("access-control-allow-origin", "*")
        self.send_header("access-control-allow-methods", "GET,POST,DELETE,OPTIONS")
        self.send_header("access-control-allow-headers", "content-type")

    def _read_json(self):
        length = int(self.headers.get("content-length", "0"))
        if length <= 0:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except json.JSONDecodeError:
            return None


def session_from_start_payload(payload, session_id=None):
    now = now_iso()
    return {
        "id": session_id or f"ai_{uuid.uuid4().hex[:12]}",
        "meetingCode": str(payload.get("meetingCode", "")),
        "participantId": str(payload.get("participantId", "")),
        "identityId": payload.get("identityId"),
        "identity": {
            "id": payload.get("identityId"),
            "kind": payload.get("identityKind"),
            "version": payload.get("identityVersion"),
            "artifactUri": payload.get("identityArtifactUri"),
            "cachedArtifactUri": payload.get("identityCachedArtifactUri"),
            "localArtifactPath": payload.get("identityLocalArtifactPath"),
            "artifactSha256": payload.get("identityArtifactSha256"),
            "artifactSizeBytes": payload.get("identityArtifactSizeBytes"),
            "artifactCacheMessage": payload.get("identityArtifactCacheMessage"),
        },
        "enabled": {
            "face": bool(payload.get("faceEnabled", False)),
            "background": bool(payload.get("backgroundEnabled", False)),
            "voice": bool(payload.get("voiceEnabled", False)),
        },
        "background": background_payload_from_session_start(payload),
        "status": "running",
        "mode": ai_mode(),
        "target": {
            "width": int(payload.get("targetWidth", DEFAULT_WIDTH) or DEFAULT_WIDTH),
            "height": int(payload.get("targetHeight", DEFAULT_HEIGHT) or DEFAULT_HEIGHT),
            "fps": int(payload.get("targetFps", DEFAULT_FPS) or DEFAULT_FPS),
        },
        "startedAt": now,
        "updatedAt": now,
        "framesProcessed": 0,
        "lastTick": time.time(),
        "frameBridgeActive": False,
        "lastFrameAt": None,
        "lastFrameLatencyMs": None,
        "lastFrameSequence": None,
        "audioBridgeActive": False,
        "audioChunksProcessed": 0,
        "lastAudioAt": None,
        "lastAudioLatencyMs": None,
        "lastAudioSequence": None,
        "lastAdapterError": None,
    }


def process_frame_for_session(session, payload):
    started = time.perf_counter()
    sequence = int(payload.get("sequence", 0) or 0)
    effects = payload.get("effects") if isinstance(payload.get("effects"), dict) else {}
    session["enabled"] = {
        "face": bool(effects.get("face", session["enabled"]["face"])),
        "background": bool(effects.get("background", session["enabled"]["background"])),
        "voice": bool(effects.get("voice", session["enabled"]["voice"])),
    }
    session["frameBridgeActive"] = True
    session["framesProcessed"] += 1
    session["lastFrameAt"] = now_iso()
    session["lastFrameSequence"] = sequence
    latency_ms = max(1, int((time.perf_counter() - started) * 1000) + estimated_model_latency(session))
    session["lastFrameLatencyMs"] = latency_ms
    session["updatedAt"] = now_iso()
    session["warnings"] = session_warnings(session)

    width = int(payload.get("width", session["target"]["width"]) or session["target"]["width"])
    height = int(payload.get("height", session["target"]["height"]) or session["target"]["height"])
    mode = ai_mode()
    external_frame = proxy_video_frame(session, payload, width, height)

    if external_frame:
        return external_frame

    frame_data = payload.get("frameDataUrl")
    return {
        "sequence": sequence,
        "status": "passthrough",
        "processor": "development-passthrough" if mode == "development-passthrough" else "adapter-contract",
        "frame": {
            "dataUrl": frame_data,
            "width": width,
            "height": height,
            "format": "image/jpeg",
        },
        "metrics": session_metrics(session),
        "warnings": frame_warnings(session, mode),
    }


def process_audio_for_session(session, payload):
    started = time.perf_counter()
    sequence = int(payload.get("sequence", 0) or 0)
    audio_data = payload.get("audioDataBase64")
    session["audioBridgeActive"] = True
    session["audioChunksProcessed"] += 1
    session["lastAudioAt"] = now_iso()
    session["lastAudioSequence"] = sequence
    latency_ms = max(1, int((time.perf_counter() - started) * 1000) + 4)
    session["lastAudioLatencyMs"] = latency_ms
    session["updatedAt"] = now_iso()
    session["warnings"] = session_warnings(session)

    external_audio = proxy_audio_chunk(session, payload)
    if external_audio:
        return external_audio

    return {
        "sequence": sequence,
        "status": "passthrough",
        "processor": "development-passthrough" if ai_mode() == "development-passthrough" else "adapter-contract",
        "audio": {
            "audioDataBase64": audio_data,
            "sampleRate": int(payload.get("sampleRate", 48000) or 48000),
            "channels": int(payload.get("channels", 1) or 1),
            "format": str(payload.get("format", "pcm_f32le")),
        },
        "metrics": audio_metrics(session, len(audio_data)),
        "warnings": audio_warnings(session),
    }


def run_preflight(payload):
    started = time.perf_counter()
    session = session_from_start_payload(payload, session_id=f"preflight_{uuid.uuid4().hex[:10]}")
    session["warnings"] = session_warnings(session)
    checks = []

    if session["enabled"].get("face") or session["enabled"].get("background"):
        frame_data_url = payload.get("frameDataUrl")
        if not isinstance(frame_data_url, str) or not frame_data_url.startswith("data:image/"):
            frame_data_url = PREFLIGHT_FRAME_DATA_URL

        frame = process_frame_for_session(
            session,
            {
                "sequence": 1,
                "timestampMs": int(time.time() * 1000),
                "width": session["target"]["width"],
                "height": session["target"]["height"],
                "frameDataUrl": frame_data_url,
                "effects": {
                    "face": session["enabled"].get("face"),
                    "background": session["enabled"].get("background"),
                    "voice": session["enabled"].get("voice"),
                },
            },
        )
        checks.append(preflight_check_from_frame(frame))

    if session["enabled"].get("voice"):
        audio_base64 = payload.get("audioDataBase64")
        if not isinstance(audio_base64, str) or not audio_base64:
            audio_base64 = base64.b64encode(bytes(4096)).decode("ascii")

        audio = process_audio_for_session(
            session,
            {
                "sequence": 1,
                "timestampMs": int(time.time() * 1000),
                "sampleRate": int(payload.get("audioSampleRate", 48000) or 48000),
                "channels": 1,
                "format": "pcm_f32le",
                "audioDataBase64": audio_base64,
            },
        )
        checks.append(preflight_check_from_audio(audio))

    if not checks:
        checks.append(
            {
                "id": "runtime",
                "label": "Runtime",
                "status": "skipped",
                "processor": None,
                "latencyMs": None,
                "warnings": ["no_effects_enabled"],
            }
        )

    warnings = unique_warnings(session.get("warnings", []) + [warning for check in checks for warning in check["warnings"]])
    status = preflight_status(checks, warnings)
    return {
        "status": status,
        "checkedAt": now_iso(),
        "durationMs": elapsed_ms(started),
        "mode": session["mode"],
        "checks": checks,
        "warnings": warnings,
        "session": session_payload(session),
    }


def preflight_check_from_frame(frame):
    return {
        "id": "video",
        "label": "Video",
        "status": frame.get("status", "unknown"),
        "processor": frame.get("processor"),
        "latencyMs": (frame.get("metrics") or {}).get("latencyMs"),
        "warnings": frame.get("warnings", []),
    }


def preflight_check_from_audio(audio):
    return {
        "id": "audio",
        "label": "Audio",
        "status": audio.get("status", "unknown"),
        "processor": audio.get("processor"),
        "latencyMs": (audio.get("metrics") or {}).get("latencyMs"),
        "warnings": audio.get("warnings", []),
    }


def preflight_status(checks, warnings):
    if any(check["status"] == "error" for check in checks):
        return "failed"
    active_checks = [check for check in checks if check["status"] != "skipped"]
    if active_checks and all(check["status"] == "processed" for check in active_checks):
        return "passed"
    if ai_mode() == "development-passthrough" and not warnings:
        return "passed"
    return "warning"


def session_payload(session):
    tick_session(session)
    enabled = session["enabled"]
    session["warnings"] = session_warnings(session)
    pipelines = []

    for pipeline in pipelines_for_session(session):
        pipeline_id = pipeline["id"]
        is_enabled = enabled.get(pipeline_id, False)
        if session["status"] == "stopped":
            status = "stopped"
            detail = "Sesión detenida."
            latency_ms = None
        else:
            status = "running" if is_enabled else "standby"
            detail = "Activo en sesión local." if is_enabled else pipeline["detail"]
            latency_ms = session.get("lastFrameLatencyMs") if is_enabled and session.get("frameBridgeActive") else pipeline.get("latencyMs")

        pipelines.append(
            {
                **pipeline,
                "status": status,
                "detail": detail,
                "latencyMs": latency_ms,
            }
        )

    return {
        "id": session["id"],
        "meetingCode": session["meetingCode"],
        "participantId": session["participantId"],
        "identityId": session["identityId"],
        "identity": session.get("identity"),
        "status": session["status"],
        "mode": session["mode"],
        "startedAt": session["startedAt"],
        "updatedAt": session["updatedAt"],
        "enabled": enabled,
        "background": session_background_payload(session),
        "metrics": session_metrics(session),
        "pipelines": pipelines,
        "warnings": session.get("warnings", []),
        "adapterError": session.get("lastAdapterError"),
    }


def tick_session(session):
    if session.get("frameBridgeActive"):
        return

    now = time.time()
    elapsed = max(0, now - session.get("lastTick", now))
    session["framesProcessed"] += int(elapsed * 30)
    session["lastTick"] = now
    session["updatedAt"] = now_iso()


def session_metrics(session):
    enabled = session["enabled"]
    active_count = sum(1 for value in enabled.values() if value)
    target = session.get("target", {})
    target_fps = int(target.get("fps", DEFAULT_FPS) or DEFAULT_FPS)
    latency = session.get("lastFrameLatencyMs") or estimated_model_latency(session)
    fps = max(1, min(target_fps, target_fps - max(0, active_count - 1)))
    width = int(target.get("width", DEFAULT_WIDTH) or DEFAULT_WIDTH)
    height = int(target.get("height", DEFAULT_HEIGHT) or DEFAULT_HEIGHT)

    return {
        "fps": fps,
        "latencyMs": latency,
        "framesProcessed": session["framesProcessed"],
        "audioChunksProcessed": session.get("audioChunksProcessed", 0),
        "vramMb": estimated_vram(enabled),
        "resolution": f"{width}x{height}",
    }


def pipelines_for_session(session=None):
    pipelines = []

    for config in PIPELINE_CONFIGS:
        engine = engine_diagnostic(config)
        ready = engine["status"] in {"ready", "standby"}
        status = "standby" if ready else "offline"
        detail = config["detail"] if ready else f"Configura {config['enabledEnv']} o {config['endpointEnv']} para activar este motor."

        pipelines.append(
            {
                "id": config["id"],
                "label": config["label"],
                "status": status,
                "model": engine["model"],
                "detail": detail,
                "latencyMs": None if session is None else session.get("lastFrameLatencyMs"),
                "engine": {
                    "configured": engine["configured"],
                    "endpointConfigured": engine["endpointConfigured"],
                    "commandConfigured": engine["commandConfigured"],
                    "requiredEnv": config["enabledEnv"],
                },
            }
        )

    return pipelines


def proxy_video_frame(session, frame_payload, width, height):
    endpoint = processor_endpoint("video")
    if not endpoint or not (session["enabled"].get("face") or session["enabled"].get("background")):
        return None

    try:
        response = post_external_json(
            endpoint,
            {
                "session": external_session_payload(session),
                "frame": frame_payload,
                "identity": session.get("identity"),
                "background": session.get("background"),
                "enabled": session.get("enabled"),
                "target": session.get("target"),
            },
        )
        frame = response.get("frame") if isinstance(response, dict) else None
        if not isinstance(frame, dict):
            raise ValueError("external_processor_missing_frame")

        result_frame = frame.get("frame") if isinstance(frame.get("frame"), dict) else {}
        if not isinstance(result_frame.get("dataUrl"), str):
            result_frame["dataUrl"] = frame_payload["frameDataUrl"]

        return {
            "sequence": int(frame.get("sequence", frame_payload.get("sequence", 0)) or 0),
            "status": str(frame.get("status", "processed")),
            "processor": str(frame.get("processor", "external-video-processor")),
            "frame": {
                "dataUrl": result_frame["dataUrl"],
                "width": int(result_frame.get("width", width) or width),
                "height": int(result_frame.get("height", height) or height),
                "format": str(result_frame.get("format", "image/jpeg")),
            },
            "metrics": frame.get("metrics") if isinstance(frame.get("metrics"), dict) else session_metrics(session),
            "warnings": unique_warnings(frame.get("warnings", []) + session.get("warnings", [])),
        }
    except Exception as error:
        session["lastAdapterError"] = f"video_processor_error: {error}"
        capture_sidecar_exception(error, {"processor": "video", "sessionId": session.get("id")})
        return None


def proxy_audio_chunk(session, audio_payload):
    endpoint = processor_endpoint("audio")
    if not endpoint or not session["enabled"].get("voice"):
        return None

    try:
        response = post_external_json(
            endpoint,
            {
                "session": external_session_payload(session),
                "audio": audio_payload,
                "identity": session.get("identity"),
                "enabled": session.get("enabled"),
            },
        )
        audio = response.get("audio") if isinstance(response, dict) else None
        if not isinstance(audio, dict):
            raise ValueError("external_processor_missing_audio")

        result_audio = audio.get("audio") if isinstance(audio.get("audio"), dict) else {}
        if not isinstance(result_audio.get("audioDataBase64"), str):
            result_audio["audioDataBase64"] = audio_payload["audioDataBase64"]

        return {
            "sequence": int(audio.get("sequence", audio_payload.get("sequence", 0)) or 0),
            "status": str(audio.get("status", "processed")),
            "processor": str(audio.get("processor", "external-audio-processor")),
            "audio": {
                "audioDataBase64": result_audio["audioDataBase64"],
                "sampleRate": int(result_audio.get("sampleRate", audio_payload.get("sampleRate", 48000)) or 48000),
                "channels": int(result_audio.get("channels", audio_payload.get("channels", 1)) or 1),
                "format": str(result_audio.get("format", audio_payload.get("format", "pcm_f32le"))),
            },
            "metrics": audio.get("metrics") if isinstance(audio.get("metrics"), dict) else audio_metrics(session, len(result_audio["audioDataBase64"])),
            "warnings": unique_warnings(audio.get("warnings", []) + session.get("warnings", [])),
        }
    except Exception as error:
        session["lastAdapterError"] = f"audio_processor_error: {error}"
        capture_sidecar_exception(error, {"processor": "audio", "sessionId": session.get("id")})
        return None


def post_external_json(endpoint, payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib_request.Request(
        endpoint,
        data=body,
        headers={"content-type": "application/json", "accept": "application/json"},
        method="POST",
    )

    try:
        with urllib_request.urlopen(request, timeout=external_processor_timeout()) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib_error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:240]
        raise RuntimeError(f"HTTP {error.code}: {detail}") from error


def external_session_payload(session):
    return {
        "id": session["id"],
        "meetingCode": session["meetingCode"],
        "participantId": session["participantId"],
        "identityId": session.get("identityId"),
        "mode": session.get("mode"),
        "target": session.get("target"),
        "warnings": session.get("warnings", []),
    }


def background_payload_from_session_start(payload):
    clean_plate_data_url = payload.get("backgroundCleanPlateDataUrl")
    if not isinstance(clean_plate_data_url, str) or not clean_plate_data_url.startswith("data:image/"):
        clean_plate_data_url = None

    captured_at = payload.get("backgroundCleanPlateCapturedAt")
    if not isinstance(captured_at, str) or not captured_at.strip():
        captured_at = None

    camera_device_id = payload.get("backgroundCleanPlateCameraDeviceId")
    if not isinstance(camera_device_id, str) or not camera_device_id.strip():
        camera_device_id = None

    return {
        "cleanPlate": {
            "dataUrl": clean_plate_data_url,
            "capturedAt": captured_at,
            "width": safe_int(payload.get("backgroundCleanPlateWidth")),
            "height": safe_int(payload.get("backgroundCleanPlateHeight")),
            "cameraDeviceId": camera_device_id,
        }
    }


def session_background_payload(session):
    background = session.get("background") if isinstance(session.get("background"), dict) else {}
    clean_plate = background.get("cleanPlate") if isinstance(background.get("cleanPlate"), dict) else None

    if not clean_plate:
        return {"cleanPlate": None}

    return {
        "cleanPlate": {
            "ready": bool(clean_plate.get("dataUrl")),
            "capturedAt": clean_plate.get("capturedAt"),
            "width": clean_plate.get("width"),
            "height": clean_plate.get("height"),
            "cameraDeviceId": clean_plate.get("cameraDeviceId"),
        }
    }


def audio_metrics(session, input_bytes):
    return {
        "chunksProcessed": session.get("audioChunksProcessed", 0),
        "latencyMs": session.get("lastAudioLatencyMs") or 4,
        "inputBytes": input_bytes,
    }


def diagnostics_payload():
    return {
        "checkedAt": now_iso(),
        "mode": ai_mode(),
        "platform": platform_payload(),
        "gpu": gpu_diagnostics(),
        "engines": [engine_diagnostic(config) for config in PIPELINE_CONFIGS],
        "externalProcessors": {
            "video": bool(processor_endpoint("video")),
            "audio": bool(processor_endpoint("audio")),
            "timeoutSeconds": external_processor_timeout(),
        },
        "managedProcessors": managed_processors_payload(),
        "limits": {
            "maxFrameBytes": MAX_FRAME_BYTES,
            "maxAudioBytes": MAX_AUDIO_BYTES,
            "defaultWidth": DEFAULT_WIDTH,
            "defaultHeight": DEFAULT_HEIGHT,
            "defaultFps": DEFAULT_FPS,
        },
    }


def diagnostics_summary():
    diagnostics = diagnostics_payload()
    return {
        "gpu": diagnostics["gpu"],
        "engines": diagnostics["engines"],
        "externalProcessors": diagnostics["externalProcessors"],
        "managedProcessors": diagnostics["managedProcessors"],
    }


def platform_payload():
    return {
        "system": platform.system(),
        "release": platform.release(),
        "machine": platform.machine(),
        "python": sys.version.split()[0],
    }


def gpu_diagnostics():
    nvidia_smi = shutil.which("nvidia-smi")
    if nvidia_smi:
        try:
            result = subprocess.run(
                [
                    nvidia_smi,
                    "--query-gpu=name,memory.total,driver_version",
                    "--format=csv,noheader,nounits",
                ],
                capture_output=True,
                check=True,
                text=True,
                timeout=2,
            )
            gpus = []
            for line in result.stdout.splitlines():
                parts = [part.strip() for part in line.split(",")]
                if len(parts) >= 3:
                    gpus.append({"name": parts[0], "memoryTotalMb": safe_int(parts[1]), "driverVersion": parts[2]})

            return {
                "status": "ready" if gpus else "missing",
                "runtime": "cuda",
                "gpus": gpus,
                "message": "GPU NVIDIA detectada." if gpus else "nvidia-smi no devolvió GPUs.",
            }
        except Exception as error:
            return {"status": "error", "runtime": "cuda", "gpus": [], "message": f"nvidia-smi falló: {error}"}

    if platform.system() == "Darwin" and platform.machine() in {"arm64", "aarch64"}:
        return {
            "status": "limited",
            "runtime": "apple-silicon",
            "gpus": [{"name": "Apple Silicon GPU", "memoryTotalMb": None, "driverVersion": None}],
            "message": "Apple Silicon detectado; usar motores CoreML/MPS cuando estén disponibles.",
        }

    return {
        "status": "missing",
        "runtime": "none",
        "gpus": [],
        "message": "No se detectó NVIDIA CUDA ni Apple Silicon.",
    }


def managed_processor_config(processor_id):
    return next((config for config in MANAGED_PROCESSOR_CONFIGS if config["id"] == processor_id), None)


def processor_endpoint(processor_id):
    config = managed_processor_config(processor_id)
    if not config:
        return None

    explicit_endpoint = env_non_empty(config["endpointEnv"])
    if explicit_endpoint:
        return explicit_endpoint

    if env_non_empty(config["commandEnv"]):
        return config["defaultEndpoint"]

    return None


def managed_processor_state(processor_id):
    state = MANAGED_PROCESSORS.get(processor_id)
    if not state:
        config = managed_processor_config(processor_id)
        if not config:
            return "unknown"
        return "configured" if env_non_empty(config["commandEnv"]) else "not-configured"

    process = state["process"]
    return "running" if process.poll() is None else "exited"


def managed_processors_payload():
    return [managed_processor_payload(config) for config in MANAGED_PROCESSOR_CONFIGS]


def managed_processor_payload(config):
    processor_id = config["id"]
    command = env_non_empty(config["commandEnv"])
    endpoint = processor_endpoint(processor_id)
    state = MANAGED_PROCESSORS.get(processor_id)

    if not state:
        return {
            "id": processor_id,
            "label": config["label"],
            "status": "not-configured" if not command else "not-started",
            "pid": None,
            "exitCode": None,
            "commandConfigured": bool(command),
            "endpoint": endpoint,
            "health": processor_health_status(config),
            "startedAt": None,
            "lastLogLine": None,
        }

    process = state["process"]
    exit_code = process.poll()
    logs = state.get("logs", [])

    return {
        "id": processor_id,
        "label": config["label"],
        "status": "running" if exit_code is None else "exited",
        "pid": process.pid,
        "exitCode": exit_code,
        "commandConfigured": True,
        "endpoint": state.get("endpoint") or endpoint,
        "health": processor_health_status(config),
        "startedAt": state.get("startedAt"),
        "lastLogLine": logs[-1] if logs else None,
    }


def processor_health_status(config):
    health_url = env_non_empty(config["healthUrlEnv"])
    if not health_url:
        return {"status": "not-configured"}

    try:
        request = urllib_request.Request(health_url, headers={"accept": "application/json"}, method="GET")
        with urllib_request.urlopen(request, timeout=0.5) as response:
            return {"status": "ready" if 200 <= response.status < 300 else "error", "code": response.status}
    except Exception as error:
        return {"status": "error", "message": str(error)[:180]}


def start_managed_processors():
    for config in MANAGED_PROCESSOR_CONFIGS:
        command = env_non_empty(config["commandEnv"])
        if not command:
            continue

        endpoint = processor_endpoint(config["id"])
        process_env = os.environ.copy()
        if endpoint:
            process_env[config["endpointEnv"]] = endpoint
            process_env["SHAPE_PROCESSOR_ENDPOINT"] = endpoint

            parsed_endpoint = urllib_parse.urlparse(endpoint)
            if parsed_endpoint.port:
                process_env[config["portEnv"]] = str(parsed_endpoint.port)
                process_env["SHAPE_PROCESSOR_PORT"] = str(parsed_endpoint.port)

        process_env["SHAPE_PROCESSOR_KIND"] = config["id"]

        try:
            process = subprocess.Popen(
                command,
                env=process_env,
                shell=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
        except Exception as error:
            print(f"[shape-ai-sidecar] no se pudo iniciar {config['id']} processor: {error}")
            capture_sidecar_exception(error, {"processor": config["id"], "phase": "start"})
            continue

        MANAGED_PROCESSORS[config["id"]] = {
            "process": process,
            "endpoint": endpoint,
            "startedAt": now_iso(),
            "logs": [],
        }
        threading.Thread(target=drain_managed_processor_logs, args=(config["id"],), daemon=True).start()
        print(f"[shape-ai-sidecar] {config['id']} processor iniciado pid={process.pid}")


def drain_managed_processor_logs(processor_id):
    state = MANAGED_PROCESSORS.get(processor_id)
    if not state:
        return

    stream = state["process"].stdout
    if not stream:
        return

    for line in stream:
        line = line.strip()
        if not line:
            continue

        logs = state.setdefault("logs", [])
        logs.append(line[:240])
        del logs[:-MANAGED_PROCESSOR_LOG_LIMIT]
        print(f"[shape-ai-sidecar:{processor_id}] {line}")


def stop_managed_processors():
    for processor_id, state in list(MANAGED_PROCESSORS.items()):
        process = state["process"]
        if process.poll() is not None:
            continue

        process.terminate()
        try:
            process.wait(timeout=4)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=2)

        print(f"[shape-ai-sidecar] {processor_id} processor detenido")


def install_shutdown_hooks():
    atexit.register(stop_managed_processors)

    def handle_shutdown(_signum, _frame):
        stop_managed_processors()
        raise SystemExit(0)

    for signal_name in ("SIGTERM", "SIGINT"):
        if hasattr(signal, signal_name):
            signal.signal(getattr(signal, signal_name), handle_shutdown)


def engine_diagnostic(config):
    mode = ai_mode()
    engine = env_non_empty(config["enabledEnv"])
    command = env_non_empty(config["commandEnv"])
    endpoint = processor_endpoint(config["processor"])
    managed_config = managed_processor_config(config["processor"])
    managed_command = env_non_empty(managed_config["commandEnv"]) if managed_config else None
    configured = bool(engine or command or endpoint or managed_command)
    command_available = command_available_status(command)

    if configured:
        status = "ready" if command_available != "missing" else "error"
    elif mode == "development-passthrough":
        status = "standby"
    else:
        status = "offline"

    return {
        "id": config["id"],
        "label": config["label"],
        "status": status,
        "model": engine or config["model"],
        "configured": configured,
        "engineEnv": config["enabledEnv"],
        "commandEnv": config["commandEnv"],
        "endpointEnv": config["endpointEnv"],
        "commandConfigured": bool(command),
        "commandAvailable": command_available,
        "endpointConfigured": bool(endpoint),
        "managedProcessorConfigured": bool(managed_command),
        "managedProcessorStatus": managed_processor_state(config["processor"]),
        "mode": mode,
    }


def command_available_status(command):
    if not command:
        return "not-configured"

    executable = command_executable(command)
    if not executable:
        return "missing"

    if os.path.isabs(executable):
        return "available" if os.path.exists(executable) else "missing"

    return "available" if shutil.which(executable) else "missing"


def command_executable(command):
    try:
        parts = shlex.split(command, posix=platform.system() != "Windows")
    except ValueError:
        parts = command.split()

    return parts[0] if parts else ""


def session_warnings(session):
    warnings = []
    enabled = session.get("enabled", {})
    identity = session.get("identity") or {}
    mode = ai_mode()

    if enabled.get("face") and not (identity.get("localArtifactPath") or identity.get("cachedArtifactUri") or identity.get("artifactUri")):
        warnings.append("identity_artifact_missing")

    background = session.get("background") if isinstance(session.get("background"), dict) else {}
    clean_plate = background.get("cleanPlate") if isinstance(background.get("cleanPlate"), dict) else {}
    if enabled.get("background") and not clean_plate.get("dataUrl"):
        warnings.append("background_clean_plate_missing")

    if mode != "development-passthrough" and (enabled.get("face") or enabled.get("background")) and not processor_endpoint("video"):
        warnings.append("video_processor_endpoint_missing")

    if mode != "development-passthrough" and enabled.get("voice") and not processor_endpoint("audio"):
        warnings.append("audio_processor_endpoint_missing")

    for config in PIPELINE_CONFIGS:
        if enabled.get(config["id"]) and engine_diagnostic(config)["status"] in {"offline", "error"}:
            warnings.append(f"{config['id']}_engine_not_ready")

    return unique_warnings(warnings)


def estimated_model_latency(session):
    enabled = session["enabled"]
    latency = 8
    if enabled.get("face"):
        latency += 18
    if enabled.get("background"):
        latency += 12
    if enabled.get("voice"):
        latency += 6
    return latency


def estimated_vram(enabled):
    vram = 0
    if enabled.get("face"):
        vram += 1800
    if enabled.get("background"):
        vram += 900
    if enabled.get("voice"):
        vram += 600
    return vram


def frame_warnings(session, mode):
    warnings = list(session.get("warnings", []))
    if mode == "development-passthrough":
        warnings.append("model_adapters_not_loaded")
    if session.get("lastAdapterError"):
        warnings.append(session["lastAdapterError"])
    return unique_warnings(warnings)


def audio_warnings(session):
    warnings = list(session.get("warnings", []))
    if ai_mode() == "development-passthrough":
        warnings.append("voice_adapter_not_loaded")
    if session.get("lastAdapterError"):
        warnings.append(session["lastAdapterError"])
    return unique_warnings(warnings)


def ai_mode():
    return os.environ.get("SHAPE_AI_MODE", "development-passthrough")


def health_message():
    mode = ai_mode()
    if mode == "development-passthrough":
        return "Servicio local de IA conectado en modo desarrollo."
    return "Servicio local de IA conectado; revisa diagnostics para motores activos."


def external_processor_timeout():
    value = safe_float(os.environ.get("SHAPE_PROCESSOR_TIMEOUT_SECS"), EXTERNAL_PROCESSOR_TIMEOUT_SECS)
    return max(0.1, min(5.0, value))


def env_non_empty(key):
    value = os.environ.get(key)
    if value is None:
        return None
    value = value.strip()
    return value or None


def request_path(path):
    return urllib_parse.urlparse(path).path


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


def elapsed_ms(started):
    return max(1, int((time.perf_counter() - started) * 1000))


def env_bool(key, default):
    value = os.environ.get(key)
    if value is None:
        return default
    return value in ("1", "true", "TRUE", "yes", "YES")


def unique_warnings(values):
    unique = []
    for value in values:
        if not value:
            continue
        text = str(value)
        if text not in unique:
            unique.append(text)
    return unique


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def init_sentry():
    global SENTRY

    sentry_explicitly_disabled = "SENTRY_DSN" in os.environ and not env_non_empty("SENTRY_DSN")
    load_local_env_files()

    if sentry_explicitly_disabled:
        return

    dsn = (
        env_non_empty("SENTRY_DSN")
        or env_non_empty("VITE_SENTRY_DSN")
        or env_non_empty("NEXT_PUBLIC_SENTRY_DSN")
    )
    if not dsn:
        return

    try:
        import sentry_sdk
        from sentry_sdk.integrations.logging import LoggingIntegration
    except Exception as error:
        print(f"[shape-ai-sidecar] sentry-sdk no disponible: {error}")
        return

    traces_sample_rate = safe_float(os.environ.get("SENTRY_TRACES_SAMPLE_RATE"), 1.0)
    sentry_sdk.init(
        dsn=dsn,
        environment=(
            os.environ.get("SENTRY_ENVIRONMENT")
            or os.environ.get("VITE_SENTRY_ENVIRONMENT")
            or os.environ.get("NEXT_PUBLIC_SENTRY_ENVIRONMENT")
            or "development"
        ),
        release=os.environ.get("SENTRY_RELEASE", "shape-ai-sidecar@0.1.0"),
        traces_sample_rate=max(0.0, min(1.0, traces_sample_rate)),
        send_default_pii=False,
        integrations=[LoggingIntegration(level=logging.INFO, event_level=logging.ERROR)],
        debug=env_bool("SENTRY_DEBUG", False),
    )
    sentry_sdk.set_tag("app.surface", "ai-sidecar")
    sentry_sdk.set_tag("ai.mode", ai_mode())
    sentry_sdk.set_context(
        "privacy",
        {
            "frames": "not-collected",
            "audio": "not-collected",
            "sourceImages": "not-collected",
            "modelArtifacts": "not-collected",
        },
    )
    SENTRY = sentry_sdk


def load_local_env_files():
    for path in local_env_file_candidates():
        if not path.exists():
            continue
        try:
            for raw_line in path.read_text(encoding="utf-8").splitlines():
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = unquote_env_value(value.strip())
                if key and value and key not in os.environ:
                    os.environ[key] = value
        except OSError as error:
            print(f"[shape-ai-sidecar] no se pudo leer env local {path}: {error}")


def local_env_file_candidates():
    repo_root = Path(__file__).resolve().parents[2]
    candidates = [
        Path.cwd() / ".env.local",
        repo_root / ".env.local",
        repo_root / "apps" / "desktop" / ".env.local",
        repo_root / "apps" / "admin" / ".env.local",
    ]

    unique = []
    for path in candidates:
        if path not in unique:
            unique.append(path)
    return unique


def unquote_env_value(value):
    if len(value) >= 2 and (
        (value.startswith('"') and value.endswith('"'))
        or (value.startswith("'") and value.endswith("'"))
    ):
        return value[1:-1]
    return value


def capture_sidecar_exception(error, context=None):
    if not SENTRY:
        return

    with SENTRY.push_scope() as scope:
        if context:
            for key, value in context.items():
                if value is not None:
                    scope.set_tag(key, str(value))
        SENTRY.capture_exception(error)


def main():
    init_sentry()
    parser = argparse.ArgumentParser(description="Shape Meet local AI sidecar")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=7851, type=int)
    args = parser.parse_args()

    install_shutdown_hooks()
    start_managed_processors()
    server = ThreadingHTTPServer((args.host, args.port), ShapeMeetHandler)
    print(f"[shape-ai-sidecar] listening on http://{args.host}:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
