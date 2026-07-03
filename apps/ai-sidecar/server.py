#!/usr/bin/env python3
import argparse
import json
import logging
import os
import platform
import re
import shutil
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
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
    },
    {
        "id": "background",
        "label": "Fondo",
        "model": "BackgroundMattingV2",
        "detail": "Adaptador preparado para matting premium 720p30.",
        "enabledEnv": "SHAPE_BACKGROUND_ENGINE",
        "commandEnv": "SHAPE_BACKGROUND_COMMAND",
        "endpointEnv": "SHAPE_VIDEO_PROCESSOR_ENDPOINT",
    },
    {
        "id": "voice",
        "label": "Voz",
        "model": "vcclient000",
        "detail": "Adaptador preparado para proxy de cambio de voz local.",
        "enabledEnv": "SHAPE_VOICE_ENGINE",
        "commandEnv": "SHAPE_VOICE_COMMAND",
        "endpointEnv": "SHAPE_AUDIO_PROCESSOR_ENDPOINT",
    },
]

SESSIONS = {}
DEFAULT_WIDTH = 1280
DEFAULT_HEIGHT = 720
DEFAULT_FPS = 30
MAX_FRAME_BYTES = 6 * 1024 * 1024
MAX_AUDIO_BYTES = 2 * 1024 * 1024
EXTERNAL_PROCESSOR_TIMEOUT_SECS = 0.8
SENTRY = None


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

        if path == "/sessions":
            payload = self._read_json()
            if payload is None:
                self._json({"error": "invalid_json"}, status=400)
                return

            session_id = f"ai_{uuid.uuid4().hex[:12]}"
            now = now_iso()
            session = {
                "id": session_id,
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
            session["warnings"] = session_warnings(session)
            SESSIONS[session_id] = session
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
            self._json({"frame": external_frame})
            return

        status = "passthrough"
        processor = "development-passthrough" if mode == "development-passthrough" else "adapter-contract"

        self._json(
            {
                "frame": {
                    "sequence": sequence,
                    "status": status,
                    "processor": processor,
                    "frame": {
                        "dataUrl": frame_data,
                        "width": width,
                        "height": height,
                        "format": "image/jpeg",
                    },
                    "metrics": session_metrics(session),
                    "warnings": frame_warnings(session, mode),
                }
            }
        )

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

        started = time.perf_counter()
        sequence = int(payload.get("sequence", 0) or 0)
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
            self._json({"audio": external_audio})
            return

        self._json(
            {
                "audio": {
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
            }
        )

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
    endpoint = env_non_empty("SHAPE_VIDEO_PROCESSOR_ENDPOINT")
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
    endpoint = env_non_empty("SHAPE_AUDIO_PROCESSOR_ENDPOINT")
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
            "video": bool(env_non_empty("SHAPE_VIDEO_PROCESSOR_ENDPOINT")),
            "audio": bool(env_non_empty("SHAPE_AUDIO_PROCESSOR_ENDPOINT")),
            "timeoutSeconds": external_processor_timeout(),
        },
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


def engine_diagnostic(config):
    mode = ai_mode()
    engine = env_non_empty(config["enabledEnv"])
    command = env_non_empty(config["commandEnv"])
    endpoint = env_non_empty(config["endpointEnv"])
    configured = bool(engine or command or endpoint)
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
        "mode": mode,
    }


def command_available_status(command):
    if not command:
        return "not-configured"

    executable = command.split()[0]
    if os.path.isabs(executable):
        return "available" if os.path.exists(executable) else "missing"

    return "available" if shutil.which(executable) else "missing"


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

    if mode != "development-passthrough" and (enabled.get("face") or enabled.get("background")) and not env_non_empty("SHAPE_VIDEO_PROCESSOR_ENDPOINT"):
        warnings.append("video_processor_endpoint_missing")

    if mode != "development-passthrough" and enabled.get("voice") and not env_non_empty("SHAPE_AUDIO_PROCESSOR_ENDPOINT"):
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

    dsn = env_non_empty("SENTRY_DSN")
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
        environment=os.environ.get("SENTRY_ENVIRONMENT", "development"),
        release=os.environ.get("SENTRY_RELEASE", "shape-ai-sidecar@0.1.0"),
        traces_sample_rate=max(0.0, min(1.0, traces_sample_rate)),
        send_default_pii=False,
        integrations=[LoggingIntegration(level=logging.INFO, event_level=logging.ERROR)],
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

    server = ThreadingHTTPServer((args.host, args.port), ShapeMeetHandler)
    print(f"[shape-ai-sidecar] listening on http://{args.host}:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
