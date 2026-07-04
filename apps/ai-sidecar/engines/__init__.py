#!/usr/bin/env python3
"""In-process AI engine registry and runtime orchestrator.

Selects the engine mode from ``SHAPE_MODEL_ENDPOINT_ENGINE`` and, for the
``inproc`` mode, owns the singleton engines that stay resident for the whole
life of the endpoint process:

  * face  -> :mod:`engines.face_insightface`
  * background -> :mod:`engines.background_matting` (RVM principal / BMV2 fallback)
  * voice -> :mod:`engines.voice_wokada`

This package is stdlib-only at import time; every heavy dependency is imported
lazily inside the engines, so the (stdlib-only) sidecar servers can import it
without pulling in torch/onnxruntime/insightface.
"""

from __future__ import annotations

import threading
import time
from typing import Any

from .runtime import (
    EngineDependencyError,
    env_flag,
    env_float,
    env_value,
    is_apple_silicon,
    probe_inproc_capabilities,
    resolve_torch_device,
)

ENGINE_INPROC = "inproc"
ENGINE_WRAPPERS = "wrappers"
ENGINE_PASSTHROUGH = "passthrough"
ENGINE_DEMO = "demo-effects"
_VALID_MODES = {ENGINE_INPROC, ENGINE_WRAPPERS, ENGINE_PASSTHROUGH, ENGINE_DEMO}


def engine_mode() -> str:
    """Resolve the endpoint engine mode.

    Honours ``SHAPE_MODEL_ENDPOINT_ENGINE`` when set to a valid value; otherwise
    falls back to the legacy flag detection (passthrough / demo-effects /
    wrappers) so existing runtime env files keep working unchanged.
    """

    explicit = (env_value("SHAPE_MODEL_ENDPOINT_ENGINE") or "").strip().lower()
    if explicit in _VALID_MODES:
        return explicit

    if env_flag("SHAPE_MODEL_ENDPOINT_PASSTHROUGH") or env_flag("SHAPE_WRAPPER_PASSTHROUGH"):
        return ENGINE_PASSTHROUGH
    if env_flag("SHAPE_MODEL_ENDPOINT_DEMO_EFFECTS"):
        return ENGINE_DEMO
    return ENGINE_WRAPPERS


_RUNTIME: "InprocRuntime | None" = None
_RUNTIME_LOCK = threading.Lock()


def get_inproc_runtime() -> "InprocRuntime":
    global _RUNTIME
    if _RUNTIME is None:
        with _RUNTIME_LOCK:
            if _RUNTIME is None:
                _RUNTIME = InprocRuntime()
    return _RUNTIME


class InprocRuntime:
    """Owns the resident engines and per-session state for ``inproc`` mode."""

    def __init__(self) -> None:
        from .background_matting import create_background_engine
        from .face_insightface import FaceEngine
        from .voice_wokada import VoiceEngine

        self.face = FaceEngine()
        self.background = create_background_engine()
        self.voice = VoiceEngine()
        self._loaded = False
        self._load_lock = threading.Lock()
        self._prepared: set[str] = set()
        self._device = None
        self.load_reports: dict[str, Any] = {}

    # -- lifecycle -------------------------------------------------------------

    def ensure_loaded(self) -> None:
        if self._loaded:
            return
        with self._load_lock:
            if self._loaded:
                return
            face_report = _safe_load(self.face)
            background_report = _safe_load(self.background)
            self.voice.load()
            self.load_reports = {
                "face": face_report,
                "background": background_report,
                "voice": None,
            }
            try:
                self._device = resolve_torch_device()
            except Exception:
                self._device = "cpu"
            self._loaded = True

    def warmup(self, timeout: float | None = None) -> None:
        """Load engines at startup, bounded by ``timeout`` seconds (soft)."""

        thread = threading.Thread(target=self.ensure_loaded, daemon=True)
        thread.start()
        thread.join(timeout)
        if thread.is_alive():
            print(
                f"[shape-model-endpoint] carga de motores inproc supera {timeout}s; "
                "sirviendo mientras terminan de cargar."
            )

    def prepare_session(self, session_id: str, identity, background, enabled) -> None:
        self.ensure_loaded()
        enabled = enabled if isinstance(enabled, dict) else {}
        if enabled.get("face") and self.face.state.loaded_at:
            try:
                self.face.prepare_session(session_id, identity)
            except EngineDependencyError:
                pass
        if enabled.get("background") and self.background.state.loaded_at:
            try:
                self.background.prepare_session(session_id, identity, background)
            except EngineDependencyError:
                pass
        self._prepared.add(session_id)

    def release_session(self, session_id: str) -> None:
        self.face.release_session(session_id)
        self.background.release_session(session_id)
        self.voice.release_session(session_id)
        self._prepared.discard(session_id)

    def shutdown(self) -> None:
        self.face.shutdown()
        self.background.shutdown()
        self.voice.shutdown()

    # -- hot path --------------------------------------------------------------

    def process_frame(self, session_id, input_bgr, identity, background, enabled) -> dict:
        self.ensure_loaded()
        enabled = enabled if isinstance(enabled, dict) else {}
        if session_id not in self._prepared:
            self.prepare_session(session_id, identity, background, enabled)

        output = input_bgr
        stages: list[dict] = []
        warnings: list[str] = []
        all_applied = True

        for stage_id, engine, wants in (
            ("face", self.face, bool(enabled.get("face"))),
            ("background", self.background, bool(enabled.get("background"))),
        ):
            if not wants:
                continue
            stage_result = self._run_stage(engine, session_id, output, stage_id)
            output = stage_result.pop("_output")
            stages.append(stage_result)
            if not stage_result["changed"]:
                all_applied = False
                warnings.append(f"{stage_id}_{stage_result['reason'] or 'not_applied'}")

        return {
            "output": output,
            "stages": stages,
            "warnings": warnings,
            "status": "processed" if all_applied else "degraded",
        }

    def _run_stage(self, engine, session_id, frame_bgr, stage_id) -> dict:
        try:
            out, meta = engine.process(session_id, frame_bgr)
        except EngineDependencyError as error:
            state = engine.state.to_dict()
            return {
                "id": stage_id,
                "_output": frame_bgr,
                "changed": False,
                "reason": state.get("reason") or "engine_load_failed",
                "detail": str(error),
                "state": state.get("state"),
                "device": state.get("device"),
                "vramMb": state.get("vramMb"),
                "latencyMs": state.get("lastLatencyMs"),
            }
        except Exception as error:  # defensive: never crash the endpoint on a frame
            engine.state.record_failure("inference_failed", str(error))
            state = engine.state.to_dict()
            return {
                "id": stage_id,
                "_output": frame_bgr,
                "changed": False,
                "reason": "inference_failed",
                "detail": str(error),
                "state": state.get("state"),
                "device": state.get("device"),
                "vramMb": state.get("vramMb"),
                "latencyMs": state.get("lastLatencyMs"),
            }
        state = engine.state.to_dict()
        return {
            "id": stage_id,
            "_output": out,
            "changed": bool(meta.get("changed")),
            "reason": meta.get("reason"),
            "detail": meta.get("detail"),
            "state": state.get("state"),
            "device": state.get("device"),
            "vramMb": state.get("vramMb"),
            "latencyMs": state.get("lastLatencyMs"),
        }

    def process_audio(self, session_id, audio_bytes, identity, sample_rate, channels, audio_format, enabled) -> dict:
        self.ensure_loaded()
        enabled = enabled if isinstance(enabled, dict) else {}
        if not enabled.get("voice"):
            return {"output": audio_bytes, "stages": [], "warnings": [], "status": "processed"}

        out, meta = self.voice.process(audio_bytes, sample_rate, channels, audio_format)
        state = self.voice.state.to_dict()
        stage = {
            "id": "voice",
            "changed": bool(meta.get("changed")),
            "reason": meta.get("reason"),
            "detail": meta.get("detail"),
            "state": state.get("state"),
            "device": state.get("device"),
            "vramMb": state.get("vramMb"),
            "latencyMs": state.get("lastLatencyMs"),
            "requestsOnConnection": meta.get("requestsOnConnection"),
            "connectionsOpened": meta.get("connectionsOpened"),
        }
        warnings = [] if stage["changed"] else [f"voice_{stage['reason'] or 'not_applied'}"]
        return {
            "output": out,
            "stages": [stage],
            "warnings": warnings,
            "status": "processed" if stage["changed"] else "degraded",
        }

    # -- diagnostics -----------------------------------------------------------

    def health(self) -> dict:
        return {
            "device": self._device,
            "loaded": self._loaded,
            "engines": {
                "face": self.face.health(),
                "background": self.background.health(),
                "voice": self.voice.health(),
            },
            "loadReports": {
                "face": self.face.load_report.to_dict(),
                "background": self.background.load_report.to_dict(),
                "voice": None,
            },
            "backgroundEngine": getattr(self.background, "engine_name", "rvm"),
            "capabilities": probe_inproc_capabilities(),
        }


def _safe_load(engine):
    try:
        report = engine.load()
        return report.to_dict() if hasattr(report, "to_dict") else report
    except EngineDependencyError as error:
        engine.state.mark_load_failed("engine_load_failed", str(error))
        return {"stage": getattr(engine, "stage_id", "?"), "ok": False, "detail": str(error)}
    except Exception as error:  # pragma: no cover - defensive
        engine.state.mark_load_failed("engine_load_failed", str(error))
        return {"stage": getattr(engine, "stage_id", "?"), "ok": False, "detail": str(error)}


def load_timeout_seconds() -> float:
    default = 30.0 if not is_apple_silicon() else 60.0
    return max(1.0, env_float("SHAPE_MODEL_ENDPOINT_LOAD_TIMEOUT_SECS", default))
