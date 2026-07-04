#!/usr/bin/env python3
"""In-process background matting engines (torch).

``RvmEngine`` (Robust Video Matting, MIT) is the principal path: it needs no
clean plate and keeps a small recurrent state per session for temporal
coherence. ``Bmv2Engine`` (BackgroundMattingV2) is the optional fallback for
hosts that already have a good clean plate.

Weights live outside the repo:
  * ``SHAPE_RVM_MODEL`` -> ``rvm_mobilenetv3.torchscript`` (self-contained) or
    ``rvm_mobilenetv3.pth`` (needs the architecture via ``torch.hub``).
  * ``BMV2_MODEL_CHECKPOINT`` -> BMV2 torchscript checkpoint (fallback only).

Background source: ``identity.backgroundAssetsPath`` (image file, or first
image in a dir) or a solid ``SHAPE_BACKGROUND_COLOR`` (``#RRGGBB`` or ``r,g,b``).
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from .runtime import (
    EngineDependencyError,
    LoadReport,
    StageState,
    data_url_to_bgr,
    decode_image_bgr,
    elapsed_ms,
    env_float,
    env_value,
    resolve_torch_device,
)

_IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
_DEFAULT_BACKGROUND = (11, 128, 67)  # BGR-ish placeholder green; overridable by env


def _parse_color(value: str | None) -> tuple[int, int, int] | None:
    if not value:
        return None
    text = value.strip()
    if text.startswith("#") and len(text) == 7:
        try:
            r = int(text[1:3], 16)
            g = int(text[3:5], 16)
            b = int(text[5:7], 16)
            return (b, g, r)  # BGR
        except ValueError:
            return None
    parts = [p.strip() for p in text.replace(";", ",").split(",") if p.strip()]
    if len(parts) == 3:
        try:
            r, g, b = (max(0, min(255, int(float(p)))) for p in parts)
            return (b, g, r)  # BGR
        except ValueError:
            return None
    return None


def _resolve_background_bgr(identity: dict | None, background: dict | None):
    """Return a background BGR image resolver spec: ('image', ndarray) | ('color', tuple)."""

    path_value = None
    if isinstance(identity, dict):
        path_value = identity.get("backgroundAssetsPath")

    if isinstance(path_value, str) and path_value.strip():
        path = Path(path_value.strip())
        image_path = None
        if path.is_file() and path.suffix.lower() in _IMAGE_SUFFIXES:
            image_path = path
        elif path.is_dir():
            for candidate in sorted(path.iterdir()):
                if candidate.suffix.lower() in _IMAGE_SUFFIXES:
                    image_path = candidate
                    break
        if image_path is not None:
            try:
                return ("image", decode_image_bgr(image_path.read_bytes()))
            except Exception:
                pass

    color = _parse_color(env_value("SHAPE_BACKGROUND_COLOR")) or _DEFAULT_BACKGROUND
    return ("color", color)


def _clean_plate_bgr(background: dict | None):
    if not isinstance(background, dict):
        return None
    path_value = background.get("cleanPlatePath")
    if isinstance(path_value, str) and path_value.strip() and Path(path_value.strip()).is_file():
        try:
            return decode_image_bgr(Path(path_value.strip()).read_bytes())
        except Exception:
            return None
    clean_plate = background.get("cleanPlate") if isinstance(background.get("cleanPlate"), dict) else {}
    data_url = clean_plate.get("dataUrl")
    if isinstance(data_url, str) and data_url.startswith("data:image/"):
        try:
            return data_url_to_bgr(data_url)
        except Exception:
            return None
    return None


class RvmEngine:
    stage_id = "background"
    engine_name = "rvm"

    def __init__(self) -> None:
        self.state = StageState(self.stage_id)
        self.load_report = LoadReport(stage=self.stage_id)
        self._model = None
        self._device = "cpu"
        self._downsample_override = env_value("SHAPE_RVM_DOWNSAMPLE")
        self._session_state: dict[str, list] = {}
        self._session_bg: dict[str, tuple[str, Any]] = {}

    def load(self) -> LoadReport:
        started = time.perf_counter()
        model_path = env_value("SHAPE_RVM_MODEL")
        if not model_path or not Path(model_path).is_file():
            detail = (
                "Modelo RVM no encontrado. Descarga rvm_mobilenetv3.torchscript o "
                "rvm_mobilenetv3.pth (PeterL1n/RobustVideoMatting, MIT) y apunta "
                "SHAPE_RVM_MODEL a su ruta."
            )
            self.state.mark_load_failed("rvm_model_missing", detail)
            self.load_report = LoadReport(stage=self.stage_id, ok=False, detail=detail)
            return self.load_report

        try:
            import torch
        except Exception as error:
            detail = (
                "torch no disponible. Instala apps/ai-sidecar/requirements-inproc-mac.txt "
                f"en el venv del endpoint. ({error})"
            )
            self.state.mark_load_failed("engine_load_failed", detail)
            self.load_report = LoadReport(stage=self.stage_id, ok=False, detail=detail)
            return self.load_report

        device = resolve_torch_device()
        warnings: list[str] = []
        try:
            if str(model_path).lower().endswith((".torchscript", ".pt", ".ts")):
                model = torch.jit.load(model_path, map_location=device)
            else:
                model = self._load_pth_via_hub(torch, model_path, device, warnings)
            model.eval()
        except Exception as error:
            detail = f"No se pudo cargar el modelo RVM: {error}"
            self.state.mark_load_failed("engine_load_failed", detail)
            self.load_report = LoadReport(stage=self.stage_id, ok=False, device=device, detail=detail)
            return self.load_report

        self._model = model
        self._device = device
        duration = elapsed_ms(started)
        detail = f"RVM mobilenetv3 en {device}."
        self.load_report = LoadReport(
            stage=self.stage_id,
            ok=True,
            device=device,
            providers=[device],
            duration_ms=duration,
            warnings=warnings,
            detail=detail,
        )
        self.state.mark_loaded(device, None, detail)
        self._warmup()
        return self.load_report

    def _warmup(self) -> None:
        """Run one tiny forward so the first real frame does not pay lazy
        device compilation (notably MPS/CUDA graph warmup)."""

        if self._model is None:
            return
        try:
            import numpy as np
            import torch

            dummy = torch.from_numpy(np.zeros((1, 3, 64, 64), dtype=np.float32)).to(self._device)
            with torch.no_grad():
                self._model(dummy, None, None, None, None, 1.0)
        except Exception:
            pass

    def _load_pth_via_hub(self, torch, model_path: str, device: str, warnings: list[str]):
        # A raw state dict needs the architecture; RVM ships it via torch.hub.
        try:
            model = torch.hub.load(
                "PeterL1n/RobustVideoMatting", "mobilenetv3", pretrained=False, trust_repo=True
            )
        except Exception as error:
            raise EngineDependencyError(
                "RVM .pth requiere la arquitectura de PeterL1n/RobustVideoMatting via "
                "torch.hub (necesita red la primera vez). Usa el .torchscript para carga "
                f"offline autocontenida. ({error})"
            ) from error
        state = torch.load(model_path, map_location="cpu", weights_only=True)
        model.load_state_dict(state)
        warnings.append("rvm_pth_via_torch_hub")
        return model.to(device)

    def prepare_session(self, session_id: str, identity: dict | None, background: dict | None) -> None:
        self._session_state[session_id] = [None, None, None, None]
        self._session_bg[session_id] = _resolve_background_bgr(identity, background)

    def release_session(self, session_id: str) -> None:
        self._session_state.pop(session_id, None)
        self._session_bg.pop(session_id, None)

    def shutdown(self) -> None:
        self._model = None
        self._session_state.clear()
        self._session_bg.clear()

    def _downsample_ratio(self, width: int, height: int) -> float:
        if self._downsample_override:
            try:
                return max(0.05, min(1.0, float(self._downsample_override)))
            except ValueError:
                pass
        longest = max(1, max(width, height))
        return max(0.25, min(1.0, 512.0 / longest))

    def _background_bgr(self, session_id: str, height: int, width: int):
        import numpy as np
        import cv2

        spec = self._session_bg.get(session_id) or ("color", _DEFAULT_BACKGROUND)
        kind, value = spec
        if kind == "image":
            return cv2.resize(value, (width, height), interpolation=cv2.INTER_AREA)
        canvas = np.zeros((height, width, 3), dtype=np.uint8)
        canvas[:, :] = value
        return canvas

    def process(self, session_id: str, frame_bgr):
        started = time.perf_counter()
        if self._model is None:
            self.state.record_failure("engine_load_failed", "RVM engine no cargado.")
            raise EngineDependencyError("RVM engine no cargado.")

        import numpy as np
        import torch

        height, width = frame_bgr.shape[:2]
        rgb = frame_bgr[:, :, ::-1].astype(np.float32) / 255.0
        src = torch.from_numpy(np.ascontiguousarray(rgb)).permute(2, 0, 1).unsqueeze(0)
        src = src.to(self._device)

        rec = self._session_state.get(session_id) or [None, None, None, None]
        ratio = self._downsample_ratio(width, height)
        try:
            with torch.no_grad():
                outputs = self._model(src, rec[0], rec[1], rec[2], rec[3], ratio)
        except Exception as error:
            detail = f"Inferencia RVM falló: {error}"
            self.state.record_failure("inference_failed", detail)
            return frame_bgr, {"changed": False, "reason": "inference_failed", "detail": detail}

        fgr, pha = outputs[0], outputs[1]
        self._session_state[session_id] = list(outputs[2:6])

        alpha = pha[0, 0].detach().to("cpu").numpy()
        foreground = fgr[0].detach().to("cpu").numpy().transpose(1, 2, 0)  # RGB float
        foreground_bgr = np.clip(foreground[:, :, ::-1] * 255.0, 0, 255)
        background_bgr = self._background_bgr(session_id, height, width).astype(np.float32)

        alpha3 = np.repeat(alpha[:, :, None], 3, axis=2)
        composite = foreground_bgr * alpha3 + background_bgr * (1.0 - alpha3)
        output = np.clip(composite, 0, 255).astype(np.uint8)

        latency = elapsed_ms(started)
        self.state.record_success(latency)
        coverage = float(alpha.mean())
        return output, {"changed": True, "reason": None, "detail": None, "coverage": coverage}

    def health(self) -> dict[str, Any]:
        return self.state.to_dict()


class Bmv2Engine:
    stage_id = "background"
    engine_name = "bmv2"

    def __init__(self) -> None:
        self.state = StageState(self.stage_id)
        self.load_report = LoadReport(stage=self.stage_id)
        self._model = None
        self._device = "cpu"
        self._session_plate: dict[str, Any] = {}
        self._session_bg: dict[str, tuple[str, Any]] = {}

    def load(self) -> LoadReport:
        started = time.perf_counter()
        checkpoint = env_value("BMV2_MODEL_CHECKPOINT")
        if not checkpoint or not Path(checkpoint).is_file():
            detail = (
                "BMV2 (fallback) requiere BMV2_MODEL_CHECKPOINT apuntando a un checkpoint "
                "torchscript de BackgroundMattingV2."
            )
            self.state.mark_load_failed("bmv2_model_missing", detail)
            self.load_report = LoadReport(stage=self.stage_id, ok=False, detail=detail)
            return self.load_report

        try:
            import torch
        except Exception as error:
            detail = f"torch no disponible para BMV2: {error}"
            self.state.mark_load_failed("engine_load_failed", detail)
            self.load_report = LoadReport(stage=self.stage_id, ok=False, detail=detail)
            return self.load_report

        device = resolve_torch_device()
        try:
            model = torch.jit.load(checkpoint, map_location=device)
            model.eval()
        except Exception as error:
            detail = (
                "BMV2 sólo soporta checkpoints torchscript en el modo inproc de fase 1. "
                f"({error})"
            )
            self.state.mark_load_failed("engine_load_failed", detail)
            self.load_report = LoadReport(stage=self.stage_id, ok=False, device=device, detail=detail)
            return self.load_report

        self._model = model
        self._device = device
        detail = f"BackgroundMattingV2 en {device}."
        self.load_report = LoadReport(
            stage=self.stage_id,
            ok=True,
            device=device,
            providers=[device],
            duration_ms=elapsed_ms(started),
            detail=detail,
        )
        self.state.mark_loaded(device, None, detail)
        return self.load_report

    def prepare_session(self, session_id: str, identity: dict | None, background: dict | None) -> None:
        self._session_plate[session_id] = _clean_plate_bgr(background)
        self._session_bg[session_id] = _resolve_background_bgr(identity, background)

    def release_session(self, session_id: str) -> None:
        self._session_plate.pop(session_id, None)
        self._session_bg.pop(session_id, None)

    def shutdown(self) -> None:
        self._model = None
        self._session_plate.clear()
        self._session_bg.clear()

    def process(self, session_id: str, frame_bgr):
        started = time.perf_counter()
        if self._model is None:
            self.state.record_failure("engine_load_failed", "BMV2 engine no cargado.")
            raise EngineDependencyError("BMV2 engine no cargado.")

        plate = self._session_plate.get(session_id)
        if plate is None:
            detail = "BMV2 requiere clean plate; no se capturó para esta sesión."
            self.state.record_failure("clean_plate_missing", detail)
            return frame_bgr, {"changed": False, "reason": "clean_plate_missing", "detail": detail}

        import numpy as np
        import cv2
        import torch

        height, width = frame_bgr.shape[:2]
        plate_resized = cv2.resize(plate, (width, height), interpolation=cv2.INTER_AREA)

        def _to_tensor(bgr):
            rgb = bgr[:, :, ::-1].astype(np.float32) / 255.0
            return torch.from_numpy(np.ascontiguousarray(rgb)).permute(2, 0, 1).unsqueeze(0).to(self._device)

        src = _to_tensor(frame_bgr)
        bgr = _to_tensor(plate_resized)
        try:
            with torch.no_grad():
                outputs = self._model(src, bgr)
        except Exception as error:
            detail = f"Inferencia BMV2 falló: {error}"
            self.state.record_failure("inference_failed", detail)
            return frame_bgr, {"changed": False, "reason": "inference_failed", "detail": detail}

        pha, fgr = outputs[0], outputs[1]
        alpha = pha[0, 0].detach().to("cpu").numpy()
        foreground = fgr[0].detach().to("cpu").numpy().transpose(1, 2, 0)
        foreground_bgr = np.clip(foreground[:, :, ::-1] * 255.0, 0, 255)

        spec = self._session_bg.get(session_id) or ("color", _DEFAULT_BACKGROUND)
        kind, value = spec
        if kind == "image":
            background_bgr = cv2.resize(value, (width, height), interpolation=cv2.INTER_AREA).astype(np.float32)
        else:
            background_bgr = np.zeros((height, width, 3), np.float32)
            background_bgr[:, :] = value

        alpha3 = np.repeat(alpha[:, :, None], 3, axis=2)
        composite = foreground_bgr * alpha3 + background_bgr * (1.0 - alpha3)
        output = np.clip(composite, 0, 255).astype(np.uint8)

        self.state.record_success(elapsed_ms(started))
        return output, {"changed": True, "reason": None, "detail": None, "coverage": float(alpha.mean())}

    def health(self) -> dict[str, Any]:
        return self.state.to_dict()


def create_background_engine():
    engine = (env_value("SHAPE_BACKGROUND_ENGINE") or "rvm").strip().lower()
    if engine in {"bmv2", "backgroundmattingv2", "bgmv2"}:
        return Bmv2Engine()
    return RvmEngine()
