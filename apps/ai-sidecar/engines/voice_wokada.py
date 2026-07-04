#!/usr/bin/env python3
"""In-process voice conversion client for w-okada / vcclient000.

w-okada is already a persistent server holding the RVC model in VRAM. Instead of
paying a Python interpreter startup per chunk (the ``vcclient000_chunk.py``
subprocess), the endpoint talks to w-okada's ``POST /test`` over a **reused**
``http.client`` connection (keep-alive).

This module is stdlib-only so ``wrappers/vcclient000_chunk.py`` can import the
S16 conversion helpers from here (single source of truth) without pulling in the
heavy in-process model dependencies.

w-okada REST contract (validated): ``POST /test`` with ``{timestamp, buffer}``
where ``buffer`` is base64 of PCM S16 mono; response ``{changedVoiceBase64}``
(or ``{data: {changedVoiceBase64}}``), S16 that is re-expanded to the output
format/channels.
"""

from __future__ import annotations

import base64
import http.client
import json
import struct
import threading
import time
import urllib.parse
from typing import Any

from .runtime import StageState, env_float, env_value


# --- S16 conversion (single source of truth; imported by the wrapper) ----------


def int16_from_float(value: float) -> int:
    clamped = max(-1.0, min(1.0, float(value)))
    return int(round(clamped * (32768 if clamped < 0 else 32767)))


def pack_mono_s16(samples) -> bytes:
    return b"".join(struct.pack("<h", max(-32768, min(32767, int(sample)))) for sample in samples)


def downmix_int16(samples, channels: int):
    if channels <= 1:
        return samples
    frame_count = len(samples) // channels
    mixed = []
    for frame in range(frame_count):
        start = frame * channels
        mixed.append(int(round(sum(samples[start : start + channels]) / channels)))
    return mixed


def expand_mono(samples, channels: int):
    if channels <= 1:
        return samples
    expanded = []
    for sample in samples:
        expanded.extend([sample] * channels)
    return expanded


def audio_bytes_to_s16_mono(raw: bytes, audio_format: str, channels: int) -> bytes:
    normalized = str(audio_format or "pcm_f32le").lower()
    if normalized in {"pcm_f32le", "f32le", "float32"}:
        sample_count = len(raw) // 4
        samples = [int16_from_float(value[0]) for value in struct.iter_unpack("<f", raw[: sample_count * 4])]
        return pack_mono_s16(downmix_int16(samples, channels))

    if normalized in {"pcm_s16le", "s16le", "int16"}:
        sample_count = len(raw) // 2
        samples = [value[0] for value in struct.iter_unpack("<h", raw[: sample_count * 2])]
        return pack_mono_s16(downmix_int16(samples, channels))

    if normalized in {"uint8-time-domain", "u8", "uint8"}:
        samples = [int(round(((byte - 128) / 128) * 32767)) for byte in raw]
        return pack_mono_s16(downmix_int16(samples, channels))

    raise ValueError(f"Formato de audio no soportado para w-okada REST: {audio_format}")


def s16_mono_to_audio_bytes(raw: bytes, audio_format: str, channels: int) -> bytes:
    sample_count = len(raw) // 2
    mono = [value[0] for value in struct.iter_unpack("<h", raw[: sample_count * 2])]
    expanded = expand_mono(mono, channels)
    normalized = str(audio_format or "pcm_f32le").lower()

    if normalized in {"pcm_f32le", "f32le", "float32"}:
        return b"".join(struct.pack("<f", max(-1.0, min(1.0, sample / 32768.0))) for sample in expanded)

    if normalized in {"pcm_s16le", "s16le", "int16"}:
        return pack_mono_s16(expanded)

    if normalized in {"uint8-time-domain", "u8", "uint8"}:
        return bytes(max(0, min(255, int(round((sample / 32768.0) * 128 + 128)))) for sample in expanded)

    raise ValueError(f"Formato de salida no soportado para w-okada REST: {audio_format}")


def _normalize_endpoint(endpoint: str) -> str:
    parsed = urllib.parse.urlparse(endpoint)
    if parsed.path and parsed.path not in {"", "/"}:
        return endpoint
    return urllib.parse.urlunparse(parsed._replace(path="/test"))


# --- persistent client ---------------------------------------------------------


class VoiceEngine:
    stage_id = "voice"

    def __init__(self) -> None:
        self.state = StageState(self.stage_id)
        self._endpoint = None
        self._host = None
        self._port = None
        self._path = "/test"
        self._scheme = "http"
        self._timeout = env_float("SHAPE_VOICE_ENDPOINT_TIMEOUT_SECS", env_float("VCCLIENT000_TIMEOUT_SECS", 2.0))
        self._lock = threading.Lock()
        self._connection = None
        self.connections_opened = 0
        self.requests_on_connection = 0

    def load(self):
        endpoint = env_value("VCCLIENT000_HTTP_ENDPOINT") or env_value("SHAPE_VOICE_ENDPOINT")
        if not endpoint:
            detail = "w-okada no configurado (VCCLIENT000_HTTP_ENDPOINT)."
            self.state.mark_load_failed("wokada_not_configured", detail)
            return self.state
        endpoint = _normalize_endpoint(endpoint)
        parsed = urllib.parse.urlparse(endpoint)
        self._endpoint = endpoint
        self._scheme = parsed.scheme or "http"
        self._host = parsed.hostname or "127.0.0.1"
        self._port = parsed.port or (443 if self._scheme == "https" else 80)
        self._path = parsed.path or "/test"
        self.state.mark_loaded(
            f"{self._host}:{self._port}", None, f"Cliente persistente w-okada {endpoint}."
        )
        return self.state

    def _new_connection(self):
        if self._scheme == "https":
            conn = http.client.HTTPSConnection(self._host, self._port, timeout=self._timeout)
        else:
            conn = http.client.HTTPConnection(self._host, self._port, timeout=self._timeout)
        self.connections_opened += 1
        self.requests_on_connection = 0
        return conn

    def _post(self, payload: dict) -> dict:
        body = json.dumps(payload).encode("utf-8")
        headers = {"content-type": "application/json", "connection": "keep-alive"}
        with self._lock:
            for attempt in range(2):
                if self._connection is None:
                    self._connection = self._new_connection()
                try:
                    self._connection.request("POST", self._path, body=body, headers=headers)
                    response = self._connection.getresponse()
                    raw = response.read()
                    self.requests_on_connection += 1
                    if response.status < 200 or response.status >= 300:
                        raise RuntimeError(f"w-okada HTTP {response.status}: {raw[:200]!r}")
                    return json.loads(raw.decode("utf-8"))
                except (http.client.HTTPException, ConnectionError, OSError) as error:
                    try:
                        if self._connection is not None:
                            self._connection.close()
                    finally:
                        self._connection = None
                    if attempt == 1:
                        raise RuntimeError(f"w-okada inaccesible: {error}") from error
        raise RuntimeError("w-okada inaccesible.")

    def process(self, audio_bytes: bytes, sample_rate: int, channels: int, audio_format: str):
        started = time.perf_counter()
        if self._endpoint is None:
            detail = "w-okada no configurado."
            self.state.record_failure("wokada_not_configured", detail)
            return audio_bytes, {"changed": False, "reason": "wokada_not_configured", "detail": detail}

        channels = max(1, int(channels or 1))
        try:
            input_s16 = audio_bytes_to_s16_mono(audio_bytes, audio_format, channels)
        except ValueError as error:
            detail = str(error)
            self.state.record_failure("audio_format_unsupported", detail)
            return audio_bytes, {"changed": False, "reason": "audio_format_unsupported", "detail": detail}

        payload = {"timestamp": int(time.time() * 1000), "buffer": base64.b64encode(input_s16).decode("ascii")}
        try:
            data = self._post(payload)
        except Exception as error:
            detail = str(error)[:200]
            self.state.record_failure("wokada_unreachable", detail)
            return audio_bytes, {"changed": False, "reason": "wokada_unreachable", "detail": detail}

        encoded = data.get("changedVoiceBase64")
        if not encoded and isinstance(data.get("data"), dict):
            encoded = data["data"].get("changedVoiceBase64")
        if not isinstance(encoded, str) or not encoded:
            detail = "w-okada no devolvió changedVoiceBase64."
            self.state.record_failure("wokada_bad_response", detail)
            return audio_bytes, {"changed": False, "reason": "wokada_bad_response", "detail": detail}

        output_s16 = base64.b64decode(encoded)
        output = s16_mono_to_audio_bytes(output_s16, audio_format, channels)
        latency = int(max(1, (time.perf_counter() - started) * 1000))
        self.state.record_success(latency)
        return output, {
            "changed": True,
            "reason": None,
            "detail": None,
            "requestsOnConnection": self.requests_on_connection,
            "connectionsOpened": self.connections_opened,
        }

    def prepare_session(self, session_id: str, identity: dict | None) -> None:  # noqa: ARG002
        return None

    def release_session(self, session_id: str) -> None:  # noqa: ARG002
        return None

    def shutdown(self) -> None:
        with self._lock:
            if self._connection is not None:
                try:
                    self._connection.close()
                finally:
                    self._connection = None

    def health(self) -> dict[str, Any]:
        payload = self.state.to_dict()
        payload["connectionsOpened"] = self.connections_opened
        payload["requestsOnConnection"] = self.requests_on_connection
        return payload
