#!/usr/bin/env python3
"""Runtime primitives shared by the in-process AI engines.

This module is deliberately stdlib-only at import time. Heavy dependencies
(``torch``, ``onnxruntime``, ``cv2``/``numpy``) are imported lazily inside the
helpers that need them so that importing ``engines`` from the (stdlib-only)
sidecar servers never pulls in the model runtime.

It provides:
  * device / execution-provider resolution per platform (CoreML/CPU on macOS,
    CUDA/CPU on NVIDIA);
  * ``LoadReport`` describing what an engine loaded (device, providers, timing,
    warnings) at startup;
  * ``StageState`` — the per-stage engine health used by ``/health`` and
    ``/diagnostics`` (state active|degraded|failed + reason + device + vramMb);
  * image codec helpers (data-url <-> BGR ndarray) so the endpoint can hand
    numpy buffers to the engines without touching disk.
"""

from __future__ import annotations

import base64
import os
import platform
import shutil
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any


STATE_ACTIVE = "active"
STATE_DEGRADED = "degraded"
STATE_FAILED = "failed"

_ONNX_PROVIDER_ALIASES = {
    "cuda": "CUDAExecutionProvider",
    "cudaexecutionprovider": "CUDAExecutionProvider",
    "coreml": "CoreMLExecutionProvider",
    "coremlexecutionprovider": "CoreMLExecutionProvider",
    "cpu": "CPUExecutionProvider",
    "cpuexecutionprovider": "CPUExecutionProvider",
    "tensorrt": "TensorrtExecutionProvider",
    "dml": "DmlExecutionProvider",
    "directml": "DmlExecutionProvider",
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def env_value(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name)
    if value is None:
        return default
    value = value.strip()
    return value or default


def env_flag(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, ""))
    except (TypeError, ValueError):
        return default


def env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, ""))
    except (TypeError, ValueError):
        return default


def is_macos() -> bool:
    return platform.system() == "Darwin"


def is_apple_silicon() -> bool:
    return is_macos() and platform.machine() in {"arm64", "aarch64"}


def has_nvidia_runtime() -> bool:
    return shutil.which("nvidia-smi") is not None


def resolve_onnx_providers(explicit: str | None = None) -> list[str]:
    """Return the ordered list of onnxruntime execution providers to request.

    Honours ``SHAPE_FACE_EXECUTION_PROVIDERS`` (comma separated, short aliases
    such as ``coreml,cpu`` or ``cuda`` accepted). Falls back to a
    platform-sensible default. The face engine intersects this with the
    providers onnxruntime actually reports as available.
    """

    raw = explicit if explicit is not None else env_value("SHAPE_FACE_EXECUTION_PROVIDERS")
    if raw:
        providers: list[str] = []
        for token in raw.replace(";", ",").split(","):
            token = token.strip()
            if not token:
                continue
            providers.append(_ONNX_PROVIDER_ALIASES.get(token.lower(), token))
        if providers:
            if "CPUExecutionProvider" not in providers:
                providers.append("CPUExecutionProvider")
            return providers

    if has_nvidia_runtime():
        return ["CUDAExecutionProvider", "CPUExecutionProvider"]
    if is_apple_silicon():
        return ["CoreMLExecutionProvider", "CPUExecutionProvider"]
    return ["CPUExecutionProvider"]


def resolve_torch_device(explicit: str | None = None) -> str:
    """Resolve the torch device string (cuda|mps|cpu).

    Honours ``SHAPE_BACKGROUND_DEVICE`` / ``BMV2_DEVICE`` / ``SHAPE_TORCH_DEVICE``.
    ``auto`` (default) picks cuda -> mps -> cpu based on what torch reports.
    """

    requested = (
        explicit
        or env_value("SHAPE_BACKGROUND_DEVICE")
        or env_value("BMV2_DEVICE")
        or env_value("SHAPE_TORCH_DEVICE")
        or "auto"
    ).strip().lower()

    try:
        import torch
    except Exception:  # pragma: no cover - torch missing is reported upstream
        return "cpu"

    def _mps_ok() -> bool:
        backend = getattr(torch.backends, "mps", None)
        return bool(backend and backend.is_available())

    if requested in {"", "auto"}:
        if torch.cuda.is_available():
            return "cuda"
        if _mps_ok():
            return "mps"
        return "cpu"

    if requested == "cuda":
        return "cuda" if torch.cuda.is_available() else "cpu"
    if requested == "mps":
        return "mps" if _mps_ok() else "cpu"
    return requested


def torch_vram_mb(device: str) -> int | None:
    """Best-effort per-process VRAM usage for CUDA. ``None`` elsewhere."""

    if not device or not device.startswith("cuda"):
        return None
    try:
        import torch

        return int(torch.cuda.memory_reserved() / (1024 * 1024))
    except Exception:  # pragma: no cover
        return None


@dataclass
class LoadReport:
    """What an engine loaded at startup — surfaced via ``/diagnostics``."""

    stage: str
    ok: bool = False
    device: str | None = None
    providers: list[str] = field(default_factory=list)
    duration_ms: int = 0
    vram_mb: int | None = None
    warnings: list[str] = field(default_factory=list)
    detail: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "stage": self.stage,
            "ok": self.ok,
            "device": self.device,
            "providers": list(self.providers),
            "durationMs": self.duration_ms,
            "vramMb": self.vram_mb,
            "warnings": list(self.warnings),
            "detail": self.detail,
        }


class StageState:
    """Per-stage engine health with load status and success/failure hysteresis.

    ``failed`` -> ``active`` only flips after ``k_recover`` real successes so an
    engine that occasionally works does not flap. ``k_fail`` consecutive
    runtime failures demote a loaded engine to ``failed``; a single failure is
    reported as ``degraded``.
    """

    def __init__(self, stage_id: str, device: str | None = None):
        self.stage_id = stage_id
        self.state = STATE_FAILED
        self.reason: str | None = "engine_not_loaded"
        self.detail = "Motor no cargado."
        self.since = now_iso()
        self.consecutive_failures = 0
        self.consecutive_successes = 0
        self.last_latency_ms: int | None = None
        self.device = device
        self.vram_mb: int | None = None
        self.loaded_at: str | None = None
        self.k_recover = max(1, env_int("SHAPE_STAGE_RECOVER_FRAMES", 2))
        self.k_fail = max(1, env_int("SHAPE_STAGE_FAIL_STREAK", 3))

    def _transition(self, state: str, reason: str | None, detail: str) -> None:
        if self.state != state:
            self.since = now_iso()
        self.state = state
        self.reason = reason
        self.detail = detail

    def mark_loaded(self, device: str | None, vram_mb: int | None, detail: str) -> None:
        self.device = device
        self.vram_mb = vram_mb
        self.loaded_at = now_iso()
        self.consecutive_failures = 0
        self.consecutive_successes = 0
        self._transition(STATE_ACTIVE, None, detail)

    def mark_load_failed(self, reason: str, detail: str) -> None:
        self.loaded_at = None
        self._transition(STATE_FAILED, reason, detail)

    def mark_degraded(self, reason: str, detail: str, device: str | None = None) -> None:
        if device is not None:
            self.device = device
        self.loaded_at = self.loaded_at or now_iso()
        self._transition(STATE_DEGRADED, reason, detail)

    def record_success(self, latency_ms: int | None) -> None:
        self.last_latency_ms = latency_ms
        self.consecutive_failures = 0
        self.consecutive_successes += 1
        if self.state == STATE_FAILED:
            if self.consecutive_successes >= self.k_recover:
                self._transition(STATE_ACTIVE, None, "Motor activo.")
        elif self.state == STATE_DEGRADED:
            if self.consecutive_successes >= self.k_recover:
                self._transition(STATE_ACTIVE, None, "Motor activo.")
        else:
            self._transition(STATE_ACTIVE, None, "Motor activo.")

    def record_failure(self, reason: str, detail: str) -> None:
        self.consecutive_failures += 1
        self.consecutive_successes = 0
        if self.consecutive_failures >= self.k_fail:
            self._transition(STATE_FAILED, reason, detail)
        else:
            self._transition(STATE_DEGRADED, reason, detail)

    def to_dict(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "reason": self.reason,
            "detail": self.detail,
            "since": self.since,
            "consecutiveFailures": self.consecutive_failures,
            "lastLatencyMs": self.last_latency_ms,
            "device": self.device,
            "vramMb": self.vram_mb,
            "loadedAt": self.loaded_at,
        }


# --- image codec helpers (numpy/cv2, lazy) -------------------------------------


def _require_cv2():
    try:
        import cv2  # noqa: F401
        import numpy as np  # noqa: F401
    except Exception as error:  # pragma: no cover - reported to caller
        raise EngineDependencyError(
            "opencv-python-headless y numpy son necesarios para el modo inproc. "
            "Instala apps/ai-sidecar/requirements-inproc-mac.txt en el venv del endpoint."
        ) from error
    return cv2, np


def decode_image_bgr(raw: bytes):
    cv2, np = _require_cv2()
    array = np.frombuffer(raw, dtype=np.uint8)
    image = cv2.imdecode(array, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("no se pudo decodificar la imagen de entrada.")
    return image


def encode_image_jpeg(bgr, quality: int = 90) -> bytes:
    cv2, _np = _require_cv2()
    ok, buffer = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, int(quality)])
    if not ok:
        raise ValueError("no se pudo codificar la imagen de salida.")
    return buffer.tobytes()


def data_url_to_bgr(data_url: str):
    if not isinstance(data_url, str) or "," not in data_url:
        raise ValueError("data url de imagen inválido.")
    _, encoded = data_url.split(",", 1)
    return decode_image_bgr(base64.b64decode(encoded))


def bgr_to_data_url(bgr, mime: str = "image/jpeg", quality: int = 90) -> str:
    encoded = base64.b64encode(encode_image_jpeg(bgr, quality)).decode("ascii")
    return f"data:{mime};base64,{encoded}"


class EngineDependencyError(RuntimeError):
    """Raised when a heavy dependency (torch/onnx/insightface/cv2) is missing.

    The endpoint turns this into an actionable ``engine_load_failed`` stage
    state and the engine smokes turn it into a legitimate ``skipped`` result.
    """


def probe_inproc_capabilities() -> dict[str, Any]:
    """Report which in-process dependencies import and which providers exist.

    Non-fatal: every field degrades gracefully so ``/diagnostics`` and the
    doctor can render partial capability without raising.
    """

    report: dict[str, Any] = {
        "torch": {"available": False},
        "onnxruntime": {"available": False, "providers": []},
        "insightface": {"available": False},
        "cv2": {"available": False},
    }

    try:
        import torch

        report["torch"] = {
            "available": True,
            "version": getattr(torch, "__version__", None),
            "cuda": bool(torch.cuda.is_available()),
            "mps": bool(getattr(getattr(torch.backends, "mps", None), "is_available", lambda: False)()),
        }
    except Exception as error:
        report["torch"] = {"available": False, "error": str(error)[:200]}

    try:
        import onnxruntime

        report["onnxruntime"] = {
            "available": True,
            "version": getattr(onnxruntime, "__version__", None),
            "providers": list(onnxruntime.get_available_providers()),
        }
    except Exception as error:
        report["onnxruntime"] = {"available": False, "providers": [], "error": str(error)[:200]}

    try:
        import insightface

        report["insightface"] = {
            "available": True,
            "version": getattr(insightface, "__version__", None),
        }
    except Exception as error:
        report["insightface"] = {"available": False, "error": str(error)[:200]}

    try:
        import cv2

        report["cv2"] = {"available": True, "version": getattr(cv2, "__version__", None)}
    except Exception as error:
        report["cv2"] = {"available": False, "error": str(error)[:200]}

    return report


def elapsed_ms(started: float) -> int:
    return max(1, int((time.perf_counter() - started) * 1000))
