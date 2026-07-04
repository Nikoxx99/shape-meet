#!/usr/bin/env python3
"""In-process voice conversion client for w-okada / vcclient000.

w-okada / VCClient is already a persistent server holding the RVC model in
VRAM. Instead of paying a Python interpreter startup per chunk (the
``vcclient000_chunk.py`` subprocess), the endpoint talks to it over a **reused**
``http.client`` connection (keep-alive).

Two server generations are supported:

  * **v1 (legacy w-okada)** — ``POST /test`` with ``{timestamp, buffer}`` where
    ``buffer`` is base64 of PCM S16 mono; response ``{changedVoiceBase64}`` (or
    ``{data: {changedVoiceBase64}}``), S16 re-expanded to the output format.
  * **v2 (VCClient 2.x)** — ``POST /api/voice-changer/convert_chunk`` with a
    ``multipart/form-data`` ``waveform`` field carrying **raw PCM Float32 LE
    mono**; the response body is **raw PCM Float32 LE mono** and the
    ``x-performance`` header carries per-chunk metrics. Health is
    ``GET /api/hello``. Shape Meet already produces ``pcm_f32le`` mono @48k, so
    against v2 the bytes travel through untouched (no S16 round-trip).

``VCCLIENT000_HTTP_MODE`` selects the protocol: ``auto`` (default) probes
``GET /api/hello`` and uses v2 when it answers, falling back to v1 otherwise;
``vcclient2`` / ``w-okada-v2`` forces v2; ``w-okada`` / ``w-okada-rest`` forces
v1.

This module is stdlib-only so ``wrappers/vcclient000_chunk.py`` can import the
conversion helpers from here (single source of truth) without pulling in the
heavy in-process model dependencies.
"""

from __future__ import annotations

import base64
import http.client
import json
import math
import os
import struct
import threading
import time
import urllib.parse
import uuid
from typing import Any

from .runtime import StageState, env_float, env_value


MODE_V1 = "wokada-v1"
MODE_V2 = "vcclient2"

V2_CONVERT_PATH = "/api/voice-changer/convert_chunk"
V2_HEALTH_PATH = "/api/hello"
V2_SLOTS_PATH = "/api/slot-manager/slots"
V2_CONFIG_PATH = "/api/configuration-manager/configuration"
V2_UPLOAD_CHUNK_PATH = "/api/uploader/upload_file_chunk"
V2_CONCAT_PATH = "/api/uploader/concat_uploaded_file_chunk"

_UPLOAD_CHUNK_BYTES = 1024 * 1024  # matches the official VCClient frontend
_DEFAULT_SAMPLE_RATE = 48000


# --- S16 conversion (v1; single source of truth, imported by the wrapper) ------


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


# --- Float32 conversion (v2; single source of truth, imported by the wrapper) --


def _unpack_f32(raw: bytes):
    sample_count = len(raw) // 4
    return [value[0] for value in struct.iter_unpack("<f", raw[: sample_count * 4])]


def _pack_f32(samples) -> bytes:
    return b"".join(struct.pack("<f", max(-1.0, min(1.0, float(sample)))) for sample in samples)


def downmix_float(samples, channels: int):
    if channels <= 1:
        return samples
    frame_count = len(samples) // channels
    mixed = []
    for frame in range(frame_count):
        start = frame * channels
        mixed.append(sum(samples[start : start + channels]) / channels)
    return mixed


def expand_float(samples, channels: int):
    if channels <= 1:
        return samples
    expanded = []
    for sample in samples:
        expanded.extend([sample] * channels)
    return expanded


def audio_bytes_to_f32_mono(raw: bytes, audio_format: str, channels: int) -> bytes:
    """Return raw PCM Float32 LE mono ready for the VCClient v2 ``waveform``.

    The common Shape Meet case (``pcm_f32le`` mono) is a zero-copy fast path: the
    bytes are already exactly what v2 wants, so they pass straight through
    (trimmed to a whole number of samples).
    """

    normalized = str(audio_format or "pcm_f32le").lower()
    channels = max(1, int(channels or 1))

    if normalized in {"pcm_f32le", "f32le", "float32"}:
        if channels <= 1:
            usable = (len(raw) // 4) * 4
            return raw[:usable]
        return _pack_f32(downmix_float(_unpack_f32(raw), channels))

    if normalized in {"pcm_s16le", "s16le", "int16"}:
        sample_count = len(raw) // 2
        samples = [value[0] / 32768.0 for value in struct.iter_unpack("<h", raw[: sample_count * 2])]
        return _pack_f32(downmix_float(samples, channels))

    if normalized in {"uint8-time-domain", "u8", "uint8"}:
        samples = [(byte - 128) / 128.0 for byte in raw]
        return _pack_f32(downmix_float(samples, channels))

    raise ValueError(f"Formato de audio no soportado para VCClient v2: {audio_format}")


def f32_mono_to_audio_bytes(raw: bytes, audio_format: str, channels: int) -> bytes:
    """Convert VCClient v2's raw Float32 LE mono output back to Shape's format."""

    normalized = str(audio_format or "pcm_f32le").lower()
    channels = max(1, int(channels or 1))

    if normalized in {"pcm_f32le", "f32le", "float32"} and channels <= 1:
        usable = (len(raw) // 4) * 4
        return raw[:usable]

    mono = _unpack_f32(raw)
    expanded = expand_float(mono, channels)

    if normalized in {"pcm_f32le", "f32le", "float32"}:
        return _pack_f32(expanded)

    if normalized in {"pcm_s16le", "s16le", "int16"}:
        return pack_mono_s16([int16_from_float(sample) for sample in expanded])

    if normalized in {"uint8-time-domain", "u8", "uint8"}:
        return bytes(
            max(0, min(255, int(round(max(-1.0, min(1.0, sample)) * 128 + 128)))) for sample in expanded
        )

    raise ValueError(f"Formato de salida no soportado para VCClient v2: {audio_format}")


def _normalize_endpoint(endpoint: str) -> str:
    parsed = urllib.parse.urlparse(endpoint)
    if parsed.path and parsed.path not in {"", "/"}:
        return endpoint
    return urllib.parse.urlunparse(parsed._replace(path="/test"))


def _normalize_mode(raw: str | None) -> str | None:
    normalized = str(raw or "auto").strip().lower().replace("_", "-")
    if normalized in {"", "auto"}:
        return None
    if normalized in {"vcclient2", "vcclient-v2", "w-okada-v2", "wokada-v2", "v2"}:
        return MODE_V2
    if normalized in {"w-okada", "w-okada-rest", "wokada", "vcclient", "vcclient-rest", "v1", "test"}:
        return MODE_V1
    return None


# --- persistent client ---------------------------------------------------------


class VoiceEngine:
    stage_id = "voice"

    def __init__(self) -> None:
        self.state = StageState(self.stage_id)
        self._endpoint = None
        self._host = None
        self._port = None
        self._base_path = "/test"
        self._convert_path = "/test"
        self._scheme = "http"
        self._timeout = env_float("SHAPE_VOICE_ENDPOINT_TIMEOUT_SECS", env_float("VCCLIENT000_TIMEOUT_SECS", 2.0))
        self._control_timeout = env_float("VCCLIENT000_CONTROL_TIMEOUT_SECS", 10.0)
        self._bootstrap_timeout = env_float("VCCLIENT000_BOOTSTRAP_TIMEOUT_SECS", 600.0)
        self._configured_mode = _normalize_mode(env_value("VCCLIENT000_HTTP_MODE"))
        self._mode: str | None = None
        self._server_sample_rate = _DEFAULT_SAMPLE_RATE
        self._last_server_latency_ms: float | None = None
        self._last_performance: dict[str, Any] | None = None
        self._lock = threading.Lock()
        self._mode_lock = threading.Lock()
        self._bootstrap_lock = threading.Lock()
        self._bootstrapped: set[str] = set()
        self._connection = None
        self.connections_opened = 0
        self.requests_on_connection = 0

    # -- lifecycle -------------------------------------------------------------

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
        self._base_path = parsed.path or "/test"
        # Convert path defaults to the configured/base path; it is finalised once
        # the protocol is resolved (lazily, on the first chunk / bootstrap) so a
        # server that is not up yet at load time does not lock us into a guess.
        self._convert_path = self._base_path
        if self._configured_mode is not None:
            self._apply_mode(self._configured_mode)
        self.state.mark_loaded(
            f"{self._host}:{self._port}", None, f"Cliente persistente w-okada {endpoint}."
        )
        return self.state

    # -- protocol resolution ---------------------------------------------------

    def _apply_mode(self, mode: str) -> None:
        self._mode = mode
        if mode == MODE_V2:
            self._convert_path = V2_CONVERT_PATH
        else:
            self._convert_path = self._base_path or "/test"

    def _ensure_mode(self) -> str:
        if self._mode is not None:
            return self._mode
        with self._mode_lock:
            if self._mode is not None:
                return self._mode
            if self._configured_mode is not None:
                self._apply_mode(self._configured_mode)
                return self._mode
            probe = self._probe_is_v2()
            if probe is True:
                self._apply_mode(MODE_V2)
            elif probe is False:
                self._apply_mode(MODE_V1)
            else:
                # Inconclusive (server unreachable): honour a v2 path hint, else v1.
                base = (self._base_path or "").rstrip("/")
                self._apply_mode(MODE_V2 if base.endswith(V2_CONVERT_PATH) else MODE_V1)
            return self._mode

    def _probe_is_v2(self) -> bool | None:
        """``True``/``False`` when reachable, ``None`` when inconclusive."""

        timeout = min(self._timeout, 1.5) if self._timeout else 1.5
        try:
            conn = self._new_connection(timeout=timeout)
            conn.request("GET", V2_HEALTH_PATH, headers={"connection": "close"})
            response = conn.getresponse()
            raw = response.read()
            conn.close()
        except (http.client.HTTPException, ConnectionError, OSError):
            return None
        if response.status != 200:
            return False
        text = raw.decode("utf-8", errors="replace").lower()
        return "vcclient" in text or "w-okada" in text or "cute voice" in text

    # -- connection ------------------------------------------------------------

    def _new_connection(self, timeout: float | None = None):
        timeout = self._timeout if timeout is None else timeout
        if self._scheme == "https":
            conn = http.client.HTTPSConnection(self._host, self._port, timeout=timeout)
        else:
            conn = http.client.HTTPConnection(self._host, self._port, timeout=timeout)
        return conn

    def _request(self, method: str, path: str, body, headers: dict):
        """Send a request on the reused keep-alive connection.

        Returns ``(status, raw_bytes, response_headers)``. Reconnects once on a
        transport error before giving up.
        """

        with self._lock:
            for attempt in range(2):
                if self._connection is None:
                    self._connection = self._new_connection()
                    self.connections_opened += 1
                    self.requests_on_connection = 0
                try:
                    self._connection.request(method, path, body=body, headers=headers)
                    response = self._connection.getresponse()
                    raw = response.read()
                    self.requests_on_connection += 1
                    resp_headers = {key.lower(): value for key, value in response.getheaders()}
                    if response.status < 200 or response.status >= 300:
                        raise RuntimeError(f"w-okada HTTP {response.status}: {raw[:200]!r}")
                    return response.status, raw, resp_headers
                except (http.client.HTTPException, ConnectionError, OSError) as error:
                    try:
                        if self._connection is not None:
                            self._connection.close()
                    finally:
                        self._connection = None
                    if attempt == 1:
                        raise RuntimeError(f"w-okada inaccesible: {error}") from error
        raise RuntimeError("w-okada inaccesible.")

    def _post(self, payload: dict) -> dict:
        body = json.dumps(payload).encode("utf-8")
        headers = {"content-type": "application/json", "connection": "keep-alive"}
        _status, raw, _headers = self._request("POST", self._convert_path, body, headers)
        return json.loads(raw.decode("utf-8"))

    def _post_chunk(self, waveform: bytes, timestamp: int):
        boundary = uuid.uuid4().hex
        preamble = (
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="waveform"; filename="chunk.bin"\r\n'
            "Content-Type: application/octet-stream\r\n\r\n"
        ).encode("ascii")
        epilogue = f"\r\n--{boundary}--\r\n".encode("ascii")
        body = preamble + waveform + epilogue
        headers = {
            "content-type": f"multipart/form-data; boundary={boundary}",
            "content-length": str(len(body)),
            "connection": "keep-alive",
            "x-timestamp": str(int(timestamp)),
        }
        _status, raw, resp_headers = self._request("POST", self._convert_path, body, headers)
        return raw, resp_headers

    # -- hot path --------------------------------------------------------------

    def process(self, audio_bytes: bytes, sample_rate: int, channels: int, audio_format: str):
        started = time.perf_counter()
        if self._endpoint is None:
            detail = "w-okada no configurado."
            self.state.record_failure("wokada_not_configured", detail)
            return audio_bytes, {"changed": False, "reason": "wokada_not_configured", "detail": detail}

        channels = max(1, int(channels or 1))
        if self._ensure_mode() == MODE_V2:
            return self._process_v2(audio_bytes, sample_rate, channels, audio_format, started)
        return self._process_v1(audio_bytes, channels, audio_format, started)

    def _process_v1(self, audio_bytes: bytes, channels: int, audio_format: str, started: float):
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
        return output, self._success_meta(MODE_V1)

    def _process_v2(self, audio_bytes: bytes, sample_rate: int, channels: int, audio_format: str, started: float):
        try:
            waveform = audio_bytes_to_f32_mono(audio_bytes, audio_format, channels)
        except ValueError as error:
            detail = str(error)
            self.state.record_failure("audio_format_unsupported", detail)
            return audio_bytes, {"changed": False, "reason": "audio_format_unsupported", "detail": detail}

        if not waveform:
            self.state.record_failure("audio_empty", "chunk de audio vacío.")
            return audio_bytes, {"changed": False, "reason": "audio_empty", "detail": "chunk de audio vacío."}

        rate = int(sample_rate or 0)
        if rate and rate != self._server_sample_rate:
            try:
                self._sync_sample_rate(rate)
            except Exception as error:
                detail = str(error)[:200]
                self.state.record_failure("vcclient_config_failed", detail)
                return audio_bytes, {"changed": False, "reason": "vcclient_config_failed", "detail": detail}

        try:
            raw, resp_headers = self._post_chunk(waveform, int(time.time() * 1000))
        except Exception as error:
            detail = str(error)[:200]
            self.state.record_failure("vcclient_unreachable", detail)
            return audio_bytes, {"changed": False, "reason": "vcclient_unreachable", "detail": detail}

        if not raw:
            detail = "VCClient v2 devolvió un cuerpo vacío."
            self.state.record_failure("vcclient_bad_response", detail)
            return audio_bytes, {"changed": False, "reason": "vcclient_bad_response", "detail": detail}

        self._record_performance(resp_headers.get("x-performance"))
        try:
            output = f32_mono_to_audio_bytes(raw, audio_format, channels)
        except ValueError as error:
            detail = str(error)
            self.state.record_failure("audio_format_unsupported", detail)
            return audio_bytes, {"changed": False, "reason": "audio_format_unsupported", "detail": detail}

        latency = int(max(1, (time.perf_counter() - started) * 1000))
        self.state.record_success(latency)
        return output, self._success_meta(MODE_V2)

    def _success_meta(self, mode: str) -> dict[str, Any]:
        return {
            "changed": True,
            "reason": None,
            "detail": None,
            "mode": mode,
            "serverLatencyMs": self._last_server_latency_ms,
            "requestsOnConnection": self.requests_on_connection,
            "connectionsOpened": self.connections_opened,
        }

    def _record_performance(self, header_value) -> None:
        if not header_value:
            return
        try:
            performance = json.loads(header_value)
        except (TypeError, ValueError):
            return
        if not isinstance(performance, dict):
            return
        self._last_performance = performance
        elapsed = performance.get("elapsed_time")
        if isinstance(elapsed, (int, float)) and math.isfinite(elapsed):
            self._last_server_latency_ms = round(float(elapsed) * 1000, 3)

    def _sync_sample_rate(self, rate: int) -> None:
        self._control_request(
            "PUT",
            V2_CONFIG_PATH,
            {"input_sample_rate": rate, "output_sample_rate": rate},
        )
        self._server_sample_rate = rate

    # -- identity bootstrap (v2) ----------------------------------------------

    def prepare_session(self, session_id: str, identity: dict | None) -> None:
        """Ensure the VCClient v2 slot for ``identity`` exists and is active.

        Idempotent per identity: the model is only uploaded when no equivalent
        slot already exists. ``index_ratio`` is always sanitised to ``0.0`` (a
        non-zero index segfaults the ARM PyInstaller build). Never raises — on
        failure the stage is marked ``failed`` with a stable reason so the video
        session keeps running.
        """

        if not isinstance(identity, dict):
            return
        model_path = _clean_path(identity.get("voiceModelPath"))
        if not model_path:
            # No identity voice package to bootstrap; keep whatever slot is active.
            return
        if self._endpoint is None:
            return
        if self._ensure_mode() != MODE_V2:
            # v1 has no slot API; identity is provisioned out-of-band.
            return

        index_path = _clean_path(identity.get("voiceIndexPath"))
        key = f"{session_id}:{model_path}:{index_path or ''}"
        with self._bootstrap_lock:
            if key in self._bootstrapped:
                return
            try:
                self._bootstrap_identity(model_path, index_path)
            except Exception as error:
                self.state.mark_load_failed("vcclient_bootstrap_failed", str(error)[:200])
                return
            self._bootstrapped.add(key)

    def _bootstrap_identity(self, model_path: str, index_path: str | None) -> None:
        desired_name = _model_name(model_path)
        model_file = os.path.basename(model_path)
        slots = self._control_request("GET", V2_SLOTS_PATH)
        slot = _find_slot(slots, desired_name, model_file)

        if slot is None:
            if not os.path.isfile(model_path):
                raise RuntimeError(f"voiceModelPath no existe: {model_path}")
            conn = self._new_connection(timeout=self._bootstrap_timeout)
            try:
                self._upload_file(conn, model_path, model_file)
                index_file = None
                if index_path and os.path.isfile(index_path):
                    index_file = os.path.basename(index_path)
                    self._upload_file(conn, index_path, index_file)
            finally:
                conn.close()
            self._control_request(
                "POST",
                V2_SLOTS_PATH,
                {
                    "slot_index": None,
                    "voice_changer_type": "RVC",
                    "name": desired_name,
                    "model_file": model_file,
                    "index_file": index_file,
                    "embedder": None,
                },
            )
            slots = self._control_request("GET", V2_SLOTS_PATH)
            slot = _find_slot(slots, desired_name, model_file)
            if slot is None:
                raise RuntimeError(f"slot no registrado tras la subida: {desired_name}")

        slot_index = slot.get("slot_index")
        if slot_index is None:
            raise RuntimeError(f"slot sin slot_index: {desired_name}")

        # Always ensure index_ratio == 0.0 (non-zero index crashes the server).
        if _as_float(slot.get("index_ratio")) != 0.0:
            sanitized = dict(slot)
            sanitized["index_ratio"] = 0.0
            self._control_request("PUT", f"{V2_SLOTS_PATH}/{slot_index}", sanitized)

        self._control_request("PUT", V2_CONFIG_PATH, {"current_slot_index": slot_index})

    def _upload_file(self, conn, local_path: str, remote_name: str) -> None:
        data = _read_file_bytes(local_path)
        total = len(data)
        chunk_count = max(1, math.ceil(total / _UPLOAD_CHUNK_BYTES))
        for index in range(chunk_count):
            part = data[index * _UPLOAD_CHUNK_BYTES : (index + 1) * _UPLOAD_CHUNK_BYTES]
            fields = [
                ("file", "chunk", "application/octet-stream", part),
                ("filename", None, None, remote_name),
                ("index", None, None, str(index)),
            ]
            self._multipart_request(conn, "POST", V2_UPLOAD_CHUNK_PATH, fields)
        form = urllib.parse.urlencode(
            {"filename": remote_name, "filename_chunk_num": str(chunk_count)}
        ).encode("ascii")
        headers = {
            "content-type": "application/x-www-form-urlencoded",
            "content-length": str(len(form)),
            "connection": "keep-alive",
        }
        _one_shot(conn, "POST", V2_CONCAT_PATH, form, headers)

    def _multipart_request(self, conn, method: str, path: str, fields) -> bytes:
        boundary = uuid.uuid4().hex
        body = _encode_multipart(boundary, fields)
        headers = {
            "content-type": f"multipart/form-data; boundary={boundary}",
            "content-length": str(len(body)),
            "connection": "keep-alive",
        }
        return _one_shot(conn, method, path, body, headers)

    def _control_request(self, method: str, path: str, payload=None):
        body = None
        headers = {"connection": "close"}
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            headers["content-type"] = "application/json"
            headers["content-length"] = str(len(body))
        conn = self._new_connection(timeout=self._control_timeout)
        try:
            raw = _one_shot(conn, method, path, body, headers)
        finally:
            conn.close()
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return {}

    # -- session lifecycle -----------------------------------------------------

    def release_session(self, session_id: str) -> None:
        with self._bootstrap_lock:
            for key in [entry for entry in self._bootstrapped if entry.startswith(f"{session_id}:")]:
                self._bootstrapped.discard(key)

    def shutdown(self) -> None:
        with self._lock:
            if self._connection is not None:
                try:
                    self._connection.close()
                finally:
                    self._connection = None

    def health(self) -> dict[str, Any]:
        payload = self.state.to_dict()
        payload["mode"] = self._mode or "unresolved"
        payload["configuredMode"] = self._configured_mode or "auto"
        payload["serverLatencyMs"] = self._last_server_latency_ms
        payload["connectionsOpened"] = self.connections_opened
        payload["requestsOnConnection"] = self.requests_on_connection
        return payload


# --- module-level helpers ------------------------------------------------------


def _clean_path(value) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value or None


def _model_name(model_path: str) -> str:
    base = os.path.basename(model_path)
    stem, _ext = os.path.splitext(base)
    return stem or base


def _find_slot(slots, desired_name: str, model_file: str):
    if not isinstance(slots, list):
        return None
    for slot in slots:
        if not isinstance(slot, dict):
            continue
        if slot.get("name") == desired_name or slot.get("model_file") == model_file:
            return slot
    return None


def _as_float(value) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _read_file_bytes(path: str) -> bytes:
    with open(path, "rb") as handle:
        return handle.read()


def _encode_multipart(boundary: str, fields) -> bytes:
    body = bytearray()
    for name, filename, content_type, value in fields:
        body += f"--{boundary}\r\n".encode("ascii")
        if filename is not None:
            body += (
                f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
            ).encode("ascii")
            body += f"Content-Type: {content_type or 'application/octet-stream'}\r\n\r\n".encode("ascii")
            body += value if isinstance(value, (bytes, bytearray)) else str(value).encode("utf-8")
        else:
            body += f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("ascii")
            body += str(value).encode("utf-8")
        body += b"\r\n"
    body += f"--{boundary}--\r\n".encode("ascii")
    return bytes(body)


def _one_shot(conn, method: str, path: str, body, headers: dict) -> bytes:
    conn.request(method, path, body=body, headers=headers)
    response = conn.getresponse()
    raw = response.read()
    if response.status < 200 or response.status >= 300:
        raise RuntimeError(f"VCClient HTTP {response.status} en {path}: {raw[:200]!r}")
    return raw
