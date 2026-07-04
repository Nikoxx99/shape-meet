import { processAiFrame, type AiFrameProcessResult } from "./aiSidecar";

// Phase 1 (§4): drop a processed frame older than this so a stalled sidecar
// falls back to the clean camera quickly instead of freezing a stale effect.
const FRAME_FRESHNESS_MS = 500;

export interface ProcessedVideoOptions {
  faceEnabled: boolean;
  backgroundEnabled: boolean;
  voiceEnabled: boolean;
  label: string;
  width?: number;
  height?: number;
  fps?: number;
  aiSessionId?: string | null;
  sidecarFps?: number;
  onStatusChange?: (status: ProcessedVideoRuntimeStatus) => void;
}

export interface ProcessedVideoPipeline {
  track: MediaStreamTrack;
  stop: () => void;
  getStatus: () => ProcessedVideoRuntimeStatus;
}

export interface ProcessedVideoRuntimeStatus {
  mode: "sidecar" | "local-fallback";
  state: "starting" | "processing" | "degraded" | "fallback" | "stopped";
  message: string;
  fps: number | null;
  latencyMs: number | null;
  framesProcessed: number;
  processor: string | null;
  warnings: string[];
  // Stable reason code for a degraded/fallback frame (e.g. wokada_unreachable,
  // identity_face_not_detected) so the UI can explain WHY the effect is off.
  reason: string | null;
  lastError: string | null;
}

export async function createProcessedVideoPipeline(
  inputTrack: MediaStreamTrack,
  options: ProcessedVideoOptions,
): Promise<ProcessedVideoPipeline> {
  const width = options.width ?? 1280;
  const height = options.height ?? 720;
  const fps = options.fps ?? 30;
  const sidecarFps = Math.min(Math.max(options.sidecarFps ?? 12, 1), fps);
  const inputStream = new MediaStream([inputTrack]);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = inputStream;

  await video.play();

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Canvas 2D no disponible para el pipeline local.");
  }

  const inputCanvas = document.createElement("canvas");
  inputCanvas.width = width;
  inputCanvas.height = height;
  const inputContext = inputCanvas.getContext("2d");

  if (!inputContext) {
    throw new Error("Canvas 2D no disponible para capturar frames locales.");
  }

  const outputStream = canvas.captureStream(fps);
  const [track] = outputStream.getVideoTracks();

  if (!track) {
    throw new Error("No se pudo crear el track procesado.");
  }

  let stopped = false;
  let frameHandle = 0;
  let sequence = 0;
  let inFlight = false;
  let lastSidecarRequestAt = 0;
  let lastProcessedImage: HTMLImageElement | null = null;
  let lastProcessedAt = 0;
  let sidecarFailures = 0;
  let status: ProcessedVideoRuntimeStatus = {
    mode: options.aiSessionId ? "sidecar" : "local-fallback",
    state: options.aiSessionId ? "starting" : "fallback",
    message: options.aiSessionId
      ? "Conectando sidecar de frames."
      : "Publicando cámara sin sidecar.",
    fps: null,
    latencyMs: null,
    framesProcessed: 0,
    processor: null,
    warnings: [],
    reason: null,
    lastError: null,
  };

  function updateStatus(next: Partial<ProcessedVideoRuntimeStatus>) {
    status = { ...status, ...next };
    options.onStatusChange?.(status);
  }

  function drawFrame() {
    if (stopped) return;

    drawCameraFrame(inputContext!, video, inputCanvas);
    drawOutputFrame(
      context!,
      inputCanvas,
      lastProcessedImage,
      Date.now() - lastProcessedAt < FRAME_FRESHNESS_MS,
    );
    scheduleSidecarFrame();
    frameHandle = window.requestAnimationFrame(drawFrame);
  }

  updateStatus({});
  drawFrame();

  return {
    track,
    getStatus: () => status,
    stop: () => {
      stopped = true;
      updateStatus({ state: "stopped", message: "Pipeline detenido." });
      window.cancelAnimationFrame(frameHandle);
      track.stop();
      inputTrack.stop();
      video.pause();
      video.srcObject = null;
    },
  };

  function scheduleSidecarFrame() {
    if (!options.aiSessionId || inFlight || stopped) return;

    const now = Date.now();
    if (now - lastSidecarRequestAt < 1000 / sidecarFps) return;

    lastSidecarRequestAt = now;
    inFlight = true;
    const currentSequence = ++sequence;

    void canvasToDataUrl(inputCanvas)
      .then((frameDataUrl) =>
        processAiFrame(options.aiSessionId!, {
          sequence: currentSequence,
          timestampMs: now,
          width,
          height,
          frameDataUrl,
          effects: {
            face: options.faceEnabled,
            background: options.backgroundEnabled,
            voice: options.voiceEnabled,
          },
        }),
      )
      .then(async (result) => {
        if (stopped || result.sequence !== currentSequence) return;

        sidecarFailures = 0;
        const image = await loadFrameImage(result);
        if (image) {
          lastProcessedImage = image;
          lastProcessedAt = Date.now();
        }
        const reason = reasonFromResult(result);
        const effectFailed =
          result.status === "error" || result.status === "degraded";
        updateStatus({
          mode: "sidecar",
          state: effectFailed
            ? result.status === "degraded"
              ? "degraded"
              : "fallback"
            : "processing",
          message: sidecarMessage(result, reason),
          fps: result.metrics.fps,
          latencyMs: result.metrics.latencyMs,
          framesProcessed: result.metrics.framesProcessed,
          processor: result.processor,
          warnings: result.warnings ?? [],
          reason,
          lastError: null,
        });
      })
      .catch((error) => {
        sidecarFailures += 1;
        updateStatus({
          mode: "local-fallback",
          state: "fallback",
          message:
            sidecarFailures > 2
              ? "Sidecar sin respuesta; publicando cámara limpia."
              : "Esperando sidecar.",
          processor: null,
          lastError:
            error instanceof Error
              ? error.message
              : "No se pudo procesar frame.",
        });
      })
      .finally(() => {
        inFlight = false;
      });
  }
}

function drawCameraFrame(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
) {
  const { width, height } = canvas;

  context.save();
  context.fillStyle = "#0b1220";
  context.fillRect(0, 0, width, height);

  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    context.restore();
    return;
  }

  const videoWidth = video.videoWidth || width;
  const videoHeight = video.videoHeight || height;
  const scale = Math.max(width / videoWidth, height / videoHeight);
  const drawWidth = videoWidth * scale;
  const drawHeight = videoHeight * scale;
  const x = (width - drawWidth) / 2;
  const y = (height - drawHeight) / 2;

  context.drawImage(video, x, y, drawWidth, drawHeight);
  context.restore();
}

function drawOutputFrame(
  context: CanvasRenderingContext2D,
  inputCanvas: HTMLCanvasElement,
  processedImage: HTMLImageElement | null,
  processedFresh: boolean,
) {
  const { width, height } = inputCanvas;

  context.save();
  context.clearRect(0, 0, width, height);

  if (processedImage && processedFresh) {
    context.drawImage(processedImage, 0, 0, width, height);
  } else {
    context.drawImage(inputCanvas, 0, 0, width, height);
  }

  context.restore();
}

function canvasToDataUrl(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("No se pudo codificar el frame local."));
          return;
        }

        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () =>
          reject(new Error("No se pudo leer el frame codificado."));
        reader.readAsDataURL(blob);
      },
      "image/jpeg",
      0.82,
    );
  });
}

function loadFrameImage(
  result: AiFrameProcessResult,
): Promise<HTMLImageElement | null> {
  if (!result.frame?.dataUrl) return Promise.resolve(null);

  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = result.frame!.dataUrl;
  });
}

function reasonFromResult(result: AiFrameProcessResult): string | null {
  const failedStage = result.stages?.find(
    (stage) => stage.changed === false && stage.reason,
  );
  if (failedStage?.reason) return failedStage.reason;
  const warning = result.warnings?.find((entry) => entry.includes("_"));
  return warning ?? null;
}

function sidecarMessage(result: AiFrameProcessResult, reason: string | null) {
  if (result.processor === "development-passthrough")
    return "Sidecar conectado en modo passthrough.";
  if (result.status === "degraded") {
    return reason
      ? `IA en fallback (motor caído: ${reason}).`
      : "IA en fallback: efecto no disponible.";
  }
  if (result.status === "error") {
    return reason
      ? `Error de IA (${reason}); publicando cámara limpia.`
      : "Error de IA; publicando cámara limpia.";
  }
  if (result.status === "passthrough")
    return "Frame validado sin modelo activo.";
  return `${result.processor} procesando frames.`;
}
