import { useEffect, useRef, useState } from "react";

export interface CameraPreviewOptions {
  enabled: boolean;
  deviceId?: string;
  width?: number;
  height?: number;
  frameRate?: number;
}

export function useCameraPreview(options: CameraPreviewOptions) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(false);
  const enabled = options.enabled;
  const width = options.width ?? 1280;
  const height = options.height ?? 720;
  const frameRate = options.frameRate ?? 30;
  const deviceId = options.deviceId;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;

    async function start() {
      if (!enabled || !navigator.mediaDevices?.getUserMedia) {
        setActive(false);
        setError(null);
        return;
      }

      try {
        stream = await openCameraStream({
          deviceId,
          width,
          height,
          frameRate,
        });

        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setError(null);
        setActive(true);
      } catch (cameraError) {
        setError(cameraPreviewErrorMessage(cameraError));
        setActive(false);
      }
    }

    void start();

    return () => {
      cancelled = true;
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [deviceId, enabled, frameRate, height, width]);

  return { videoRef, error, active };
}

async function openCameraStream({
  deviceId,
  width,
  height,
  frameRate,
}: {
  deviceId?: string;
  width: number;
  height: number;
  frameRate: number;
}) {
  const constraints = {
    width,
    height,
    frameRate,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };

  try {
    return await navigator.mediaDevices.getUserMedia({
      video: constraints,
      audio: false,
    });
  } catch (error) {
    if (!deviceId) throw error;

    return navigator.mediaDevices.getUserMedia({
      video: { width, height, frameRate },
      audio: false,
    });
  }
}

function cameraPreviewErrorMessage(error: unknown) {
  if (!(error instanceof DOMException)) return "No se pudo abrir la cámara.";

  if (error.name === "NotFoundError" || error.name === "OverconstrainedError") {
    return "No hay cámara disponible.";
  }

  if (error.name === "NotAllowedError" || error.name === "SecurityError") {
    return "Permiso de cámara bloqueado.";
  }

  if (error.name === "NotReadableError") {
    return "La cámara está en uso por otra app.";
  }

  return "No se pudo abrir la cámara.";
}
