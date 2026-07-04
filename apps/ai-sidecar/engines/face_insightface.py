#!/usr/bin/env python3
"""In-process face swap engine built on insightface + onnxruntime.

Loads ``buffalo_l`` (SCRFD detector + ArcFace recogniser) and
``inswapper_128.onnx`` once at startup and keeps them resident. The source-face
embedding is computed once per session (cached by file hash) so the hot path
(``process``) is pure numpy in/out with no disk I/O.

Weights live outside the repo and are located by env:
  * ``SHAPE_INSWAPPER_MODEL`` -> path to ``inswapper_128.onnx`` (gated model).
  * ``INSIGHTFACE_HOME`` / ``SHAPE_INSIGHTFACE_HOME`` -> buffalo_l cache dir
    (insightface auto-downloads buffalo_l on first use).
"""

from __future__ import annotations

import hashlib
import os
import time
from pathlib import Path
from typing import Any

from .runtime import (
    EngineDependencyError,
    LoadReport,
    StageState,
    elapsed_ms,
    env_int,
    env_value,
    resolve_onnx_providers,
)


def _provider_short_name(provider: str) -> str:
    lowered = provider.lower()
    if "cuda" in lowered:
        return "cuda"
    if "coreml" in lowered:
        return "coreml"
    if "tensorrt" in lowered:
        return "tensorrt"
    if "dml" in lowered or "directml" in lowered:
        return "directml"
    return "cpu"


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _face_source_path(identity: dict | None) -> str | None:
    if not isinstance(identity, dict):
        return None
    for key in ("faceSourcePath", "localArtifactPath", "cachedArtifactUri", "artifactUri"):
        value = identity.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


class FaceEngine:
    stage_id = "face"

    def __init__(self) -> None:
        self.state = StageState(self.stage_id)
        self.load_report = LoadReport(stage=self.stage_id)
        self._analyzer = None
        self._swapper = None
        self._providers: list[str] = []
        self._det_size = max(160, env_int("SHAPE_FACE_DETECT_SIZE", 640))
        self._source_by_hash: dict[str, Any] = {}
        self._session_source: dict[str, Any] = {}
        self._session_reason: dict[str, tuple[str, str]] = {}

    # -- lifecycle -------------------------------------------------------------

    def load(self) -> LoadReport:
        started = time.perf_counter()
        swapper_path = env_value("SHAPE_INSWAPPER_MODEL")
        if not swapper_path or not Path(swapper_path).is_file():
            detail = (
                "inswapper_128.onnx no encontrado. Descárgalo (modelo gated de "
                "InsightFace) y apunta SHAPE_INSWAPPER_MODEL a su ruta."
            )
            self.state.mark_load_failed("inswapper_model_missing", detail)
            self.load_report = LoadReport(stage=self.stage_id, ok=False, detail=detail)
            return self.load_report

        try:
            import onnxruntime  # noqa: F401
            from insightface.app import FaceAnalysis
            from insightface.model_zoo import get_model
        except Exception as error:
            detail = (
                "insightface / onnxruntime no disponibles. Instala "
                "apps/ai-sidecar/requirements-inproc-mac.txt en el venv del endpoint. "
                f"({error})"
            )
            self.state.mark_load_failed("engine_load_failed", detail)
            self.load_report = LoadReport(stage=self.stage_id, ok=False, detail=detail)
            return self.load_report

        import onnxruntime

        requested = resolve_onnx_providers()
        available = set(onnxruntime.get_available_providers())
        providers = [p for p in requested if p in available]
        warnings: list[str] = []
        degraded_reason: str | None = None
        if not providers:
            providers = ["CPUExecutionProvider"]
        dropped = [p for p in requested if p not in available]
        if dropped:
            warnings.append("providers_no_disponibles:" + ",".join(dropped))
            if any("coreml" in p.lower() for p in dropped):
                degraded_reason = "coreml_fallback_cpu"

        insightface_home = env_value("SHAPE_INSIGHTFACE_HOME") or env_value("INSIGHTFACE_HOME")
        analyzer_root = insightface_home or os.path.expanduser("~/.insightface")

        try:
            analyzer = FaceAnalysis(
                name="buffalo_l",
                root=analyzer_root,
                providers=providers,
            )
            analyzer.prepare(ctx_id=0, det_size=(self._det_size, self._det_size))
        except Exception as error:
            detail = f"No se pudo cargar buffalo_l: {error}"
            self.state.mark_load_failed("engine_load_failed", detail)
            self.load_report = LoadReport(
                stage=self.stage_id, ok=False, providers=providers, detail=detail
            )
            return self.load_report

        try:
            swapper = get_model(swapper_path, providers=providers)
        except Exception as error:
            # CoreML can reject the inswapper graph (R1); retry on CPU and degrade.
            try:
                swapper = get_model(swapper_path, providers=["CPUExecutionProvider"])
                providers = ["CPUExecutionProvider"]
                degraded_reason = "coreml_fallback_cpu"
                warnings.append(f"inswapper_coreml_rechazado:{error}")
            except Exception as inner:
                detail = f"No se pudo cargar inswapper_128.onnx: {inner}"
                self.state.mark_load_failed("engine_load_failed", detail)
                self.load_report = LoadReport(
                    stage=self.stage_id, ok=False, providers=providers, detail=detail
                )
                return self.load_report

        self._analyzer = analyzer
        self._swapper = swapper
        self._providers = providers
        device = _provider_short_name(providers[0]) if providers else "cpu"
        duration = elapsed_ms(started)
        detail = f"buffalo_l + inswapper_128 en {device} ({', '.join(providers)})."
        self.load_report = LoadReport(
            stage=self.stage_id,
            ok=True,
            device=device,
            providers=providers,
            duration_ms=duration,
            warnings=warnings,
            detail=detail,
        )
        self.state.mark_loaded(device, None, detail)
        if degraded_reason:
            self.state.mark_degraded(
                degraded_reason,
                "CoreML no aceptó el grafo; ejecutando rostro en CPU (correcto, más lento).",
                device="cpu",
            )
        return self.load_report

    def prepare_session(self, session_id: str, identity: dict | None) -> None:
        if self._analyzer is None or self._swapper is None:
            raise EngineDependencyError("face engine no cargado.")

        source_path = _face_source_path(identity)
        if not source_path:
            self._session_reason[session_id] = (
                "face_source_missing",
                "La identidad no incluye una cara fuente (faceSourcePath).",
            )
            self._session_source.pop(session_id, None)
            return

        path = Path(source_path)
        if not path.is_file():
            self._session_reason[session_id] = (
                "face_source_missing",
                f"Cara fuente no encontrada: {source_path}",
            )
            self._session_source.pop(session_id, None)
            return

        file_hash = _sha256_file(path)
        cached = self._source_by_hash.get(file_hash)
        if cached is None:
            from .runtime import decode_image_bgr

            image = decode_image_bgr(path.read_bytes())
            faces = self._analyzer.get(image)
            if not faces:
                self._session_reason[session_id] = (
                    "face_source_not_detected",
                    "No se detectó una cara en la imagen fuente de la identidad.",
                )
                self._session_source.pop(session_id, None)
                return
            cached = max(faces, key=_face_area)
            self._source_by_hash[file_hash] = cached

        self._session_source[session_id] = cached
        self._session_reason.pop(session_id, None)

    def release_session(self, session_id: str) -> None:
        self._session_source.pop(session_id, None)
        self._session_reason.pop(session_id, None)

    def shutdown(self) -> None:
        self._analyzer = None
        self._swapper = None
        self._source_by_hash.clear()
        self._session_source.clear()

    # -- hot path --------------------------------------------------------------

    def process(self, session_id: str, frame_bgr):
        started = time.perf_counter()
        if self._analyzer is None or self._swapper is None:
            self.state.record_failure("engine_load_failed", "face engine no cargado.")
            raise EngineDependencyError("face engine no cargado.")

        source_face = self._session_source.get(session_id)
        if source_face is None:
            reason, detail = self._session_reason.get(
                session_id, ("face_source_missing", "Cara fuente no preparada.")
            )
            self.state.record_failure(reason, detail)
            return frame_bgr, {"changed": False, "reason": reason, "detail": detail}

        faces = self._analyzer.get(frame_bgr)
        if not faces:
            detail = "No se detectó una cara en el frame destino."
            self.state.record_failure("identity_face_not_detected", detail)
            return frame_bgr, {
                "changed": False,
                "reason": "identity_face_not_detected",
                "detail": detail,
            }

        output = frame_bgr
        swapped = 0
        for target_face in faces:
            output = self._swapper.get(output, target_face, source_face, paste_back=True)
            swapped += 1

        latency = elapsed_ms(started)
        self.state.record_success(latency)
        return output, {"changed": True, "reason": None, "detail": None, "faces": swapped}

    def health(self) -> dict[str, Any]:
        return self.state.to_dict()


def _face_area(face) -> float:
    bbox = face.bbox
    return float(max(0.0, bbox[2] - bbox[0]) * max(0.0, bbox[3] - bbox[1]))
