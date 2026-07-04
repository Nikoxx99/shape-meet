import type { NativeAiPipelineStatus } from "./native";

const DEFAULT_AI_SIDECAR_URL = "http://127.0.0.1:7851";
const PREFLIGHT_TIMEOUT_MS = 150_000;
const FRAME_PROCESS_TIMEOUT_MS = 80_000;
const AUDIO_PROCESS_TIMEOUT_MS = 15_000;
const PREFLIGHT_BLOCKING_WARNINGS = new Set([
  "identity_artifact_missing",
  "background_clean_plate_missing",
  "video_processor_endpoint_missing",
  "audio_processor_endpoint_missing",
]);

export interface AiSessionStartInput {
  meetingCode: string;
  participantId: string;
  identityId?: string | null;
  identityKind?: string | null;
  identityVersion?: string | null;
  identityArtifactUri?: string | null;
  identityCachedArtifactUri?: string | null;
  identityLocalArtifactPath?: string | null;
  identityArtifactSha256?: string | null;
  identityArtifactSizeBytes?: number | null;
  identityArtifactCacheMessage?: string | null;
  faceEnabled: boolean;
  backgroundEnabled: boolean;
  backgroundCleanPlateDataUrl?: string | null;
  backgroundCleanPlateCapturedAt?: string | null;
  backgroundCleanPlateWidth?: number | null;
  backgroundCleanPlateHeight?: number | null;
  backgroundCleanPlateCameraDeviceId?: string | null;
  voiceEnabled: boolean;
  targetWidth?: number;
  targetHeight?: number;
  targetFps?: number;
}

export interface AiSession {
  id: string;
  meetingCode: string;
  participantId: string;
  identityId: string | null;
  identity?: {
    id: string | null;
    kind: string | null;
    version: string | null;
    artifactUri: string | null;
    cachedArtifactUri: string | null;
    localArtifactPath: string | null;
    artifactSha256: string | null;
    artifactSizeBytes: number | null;
    artifactCacheMessage: string | null;
  };
  status: "running" | "stopped" | "error" | string;
  mode: string;
  startedAt: string;
  updatedAt: string;
  enabled: {
    face: boolean;
    background: boolean;
    voice: boolean;
  };
  background?: {
    cleanPlate: {
      ready: boolean;
      capturedAt: string | null;
      width: number | null;
      height: number | null;
      cameraDeviceId: string | null;
    } | null;
  };
  metrics: {
    fps: number;
    latencyMs: number;
    framesProcessed: number;
    audioChunksProcessed?: number;
    vramMb: number;
    resolution: string;
  };
  lastProcessed?: {
    video?: {
      sequence: number | null;
      processor: string | null;
      status: string | null;
      latencyMs: number | null;
      fps: number | null;
      vramMb: number | null;
      resolution: string | null;
      warnings: string[];
      processedAt: string | null;
    };
    audio?: {
      sequence: number | null;
      processor: string | null;
      status: string | null;
      latencyMs: number | null;
      inputBytes: number | null;
      warnings: string[];
      processedAt: string | null;
    };
  };
  pipelines: NativeAiPipelineStatus[];
  warnings?: string[];
  adapterError?: string | null;
}

export interface AiFrameProcessInput {
  sequence: number;
  timestampMs: number;
  width: number;
  height: number;
  frameDataUrl: string;
  effects: {
    face: boolean;
    background: boolean;
    voice: boolean;
  };
}

export interface AiFrameProcessResult {
  sequence: number;
  status: "processed" | "passthrough" | "error" | string;
  processor: string;
  frame?: {
    dataUrl: string;
    width: number;
    height: number;
    format: string;
  };
  metrics: {
    fps: number;
    latencyMs: number;
    framesProcessed: number;
    vramMb: number;
    resolution: string;
  };
  warnings?: string[];
}

export interface AiAudioProcessInput {
  sequence: number;
  timestampMs: number;
  sampleRate: number;
  channels: number;
  format: string;
  audioDataBase64: string;
}

export interface AiAudioProcessResult {
  sequence: number;
  status: "processed" | "passthrough" | "error" | string;
  processor: string;
  audio?: {
    audioDataBase64: string;
    sampleRate: number;
    channels: number;
    format: string;
  };
  metrics: {
    chunksProcessed: number;
    latencyMs: number;
    inputBytes: number;
  };
  warnings?: string[];
}

export interface AiDiagnostics {
  checkedAt: string;
  mode: string;
  platform: {
    system: string;
    release: string;
    machine: string;
    python: string;
  };
  gpu: {
    status: "ready" | "limited" | "missing" | "error" | string;
    runtime: string;
    message: string;
    gpus: Array<{
      name: string;
      memoryTotalMb: number | null;
      driverVersion: string | null;
    }>;
  };
  engines: Array<{
    id: string;
    label: string;
    status: string;
    model: string;
    configured: boolean;
    engineEnv: string;
    commandEnv: string;
    endpointEnv: string;
    commandConfigured: boolean;
    commandAvailable: string;
    endpointConfigured: boolean;
    managedProcessorConfigured: boolean;
    managedProcessorStatus: string;
    mode: string;
  }>;
  externalProcessors: {
    video: boolean;
    audio: boolean;
    timeoutSeconds: number;
  };
  managedProcessors: Array<{
    id: string;
    label: string;
    status: string;
    pid: number | null;
    exitCode: number | null;
    commandConfigured: boolean;
    endpoint: string | null;
    health: {
      status: string;
      code?: number;
      message?: string;
    };
    startedAt: string | null;
    lastLogLine: string | null;
  }>;
  sentry: {
    configured: boolean;
    enabled: boolean;
    sdkAvailable: boolean;
    status: string;
    message: string;
    environment: string | null;
    release: string | null;
    tracesSampleRate: number | null;
    debug: boolean;
  };
  limits: {
    maxFrameBytes: number;
    maxAudioBytes: number;
    defaultWidth: number;
    defaultHeight: number;
    defaultFps: number;
  };
}

export type AiPreflightInput = AiSessionStartInput & {
  frameDataUrl?: string | null;
  audioDataBase64?: string | null;
  audioSampleRate?: number | null;
};

export interface AiPreflightResult {
  status: "passed" | "warning" | "failed" | string;
  checkedAt: string;
  durationMs: number;
  mode: string;
  checks: Array<{
    id: "video" | "audio" | "runtime" | string;
    label: string;
    status: string;
    processor: string | null;
    latencyMs: number | null;
    warnings: string[];
  }>;
  warnings: string[];
  session: AiSession;
}

export async function startAiSession(
  input: AiSessionStartInput,
): Promise<AiSession> {
  const response = await fetch(`${aiSidecarUrl()}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = (await response.json().catch(() => ({}))) as {
    session?: AiSession;
    error?: string;
  };

  if (!response.ok || !data.session) {
    throw new Error(data.error ?? "No se pudo iniciar la sesión local de IA.");
  }

  return data.session;
}

export async function getAiDiagnostics(): Promise<AiDiagnostics> {
  const response = await fetch(`${aiSidecarUrl()}/diagnostics`);
  const data = (await response.json().catch(() => ({}))) as {
    diagnostics?: AiDiagnostics;
    error?: string;
  };

  if (!response.ok || !data.diagnostics) {
    throw new Error(
      data.error ?? "No se pudo consultar diagnostics del sidecar.",
    );
  }

  return data.diagnostics;
}

export async function runAiPreflight(
  input: AiPreflightInput,
): Promise<AiPreflightResult> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    PREFLIGHT_TIMEOUT_MS,
  );

  try {
    const response = await fetch(`${aiSidecarUrl()}/preflight`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
    const data = (await response.json().catch(() => ({}))) as {
      preflight?: AiPreflightResult;
      error?: string;
    };

    if (response.status === 404 || data.error === "not_found") {
      return runLegacyAiPreflight(input);
    }

    if (!response.ok || !data.preflight) {
      throw new Error(
        data.error ?? "No se pudo probar el runtime local de IA.",
      );
    }

    return data.preflight;
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(
        `El preflight IA agotó ${timeoutLabel(PREFLIGHT_TIMEOUT_MS)}. Revisa logs del sidecar y timeouts de modelos.`,
      );
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function runLegacyAiPreflight(
  input: AiPreflightInput,
): Promise<AiPreflightResult> {
  const startedAt = performance.now();
  const session = await startAiSession(input);
  const checks: AiPreflightResult["checks"] = [];

  try {
    if (input.faceEnabled || input.backgroundEnabled) {
      const frame = await processAiFrame(session.id, {
        sequence: 1,
        timestampMs: Date.now(),
        width: input.targetWidth ?? 1280,
        height: input.targetHeight ?? 720,
        frameDataUrl: input.frameDataUrl ?? legacyPreflightFrameDataUrl(),
        effects: {
          face: input.faceEnabled,
          background: input.backgroundEnabled,
          voice: input.voiceEnabled,
        },
      });
      checks.push({
        id: "video",
        label: "Video",
        status: frame.status,
        processor: frame.processor,
        latencyMs: frame.metrics.latencyMs,
        warnings: frame.warnings ?? [],
      });
    }

    if (input.voiceEnabled) {
      const audio = await processAiAudio(session.id, {
        sequence: 1,
        timestampMs: Date.now(),
        sampleRate: input.audioSampleRate ?? 48000,
        channels: 1,
        format: "pcm_f32le",
        audioDataBase64: input.audioDataBase64 ?? legacySilentAudioBase64(),
      });
      checks.push({
        id: "audio",
        label: "Audio",
        status: audio.status,
        processor: audio.processor,
        latencyMs: audio.metrics.latencyMs,
        warnings: audio.warnings ?? [],
      });
    }

    if (checks.length === 0) {
      checks.push({
        id: "runtime",
        label: "Runtime",
        status: "skipped",
        processor: null,
        latencyMs: null,
        warnings: ["no_effects_enabled"],
      });
    }

    const warnings = uniqueWarnings([
      ...(session.warnings ?? []),
      ...checks.flatMap((check) => check.warnings),
    ]);

    return {
      status: preflightStatus(checks, warnings, session.mode),
      checkedAt: new Date().toISOString(),
      durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
      mode: session.mode,
      checks,
      warnings,
      session,
    };
  } finally {
    await stopAiSession(session.id);
  }
}

function preflightStatus(
  checks: AiPreflightResult["checks"],
  warnings: string[],
  mode: string,
) {
  if (checks.some((check) => check.status === "error")) return "failed";
  if (warnings.some((warning) => PREFLIGHT_BLOCKING_WARNINGS.has(warning))) {
    return "failed";
  }
  const activeChecks = checks.filter((check) => check.status !== "skipped");
  if (
    activeChecks.length > 0 &&
    activeChecks.every((check) => check.status === "processed")
  ) {
    return "passed";
  }
  if (mode === "development-passthrough" && warnings.length === 0)
    return "passed";
  return "warning";
}

function uniqueWarnings(values: string[]) {
  const unique: string[] = [];
  for (const value of values) {
    if (value && !unique.includes(value)) unique.push(value);
  }
  return unique;
}

function legacyPreflightFrameDataUrl() {
  return (
    "data:image/jpeg;base64," +
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////" +
    "2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/" +
    "8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/" +
    "9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/" +
    "xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Al//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/" +
    "EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/" +
    "2gAIAQEAAT8QH//Z"
  );
}

function legacySilentAudioBase64() {
  const bytes = new Uint8Array(4096);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function processAiFrame(
  sessionId: string,
  input: AiFrameProcessInput,
): Promise<AiFrameProcessResult> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    FRAME_PROCESS_TIMEOUT_MS,
  );

  try {
    const response = await fetch(
      `${aiSidecarUrl()}/sessions/${encodeURIComponent(sessionId)}/frames`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        signal: controller.signal,
      },
    );
    const data = (await response.json().catch(() => ({}))) as {
      frame?: AiFrameProcessResult;
      error?: string;
    };

    if (!response.ok || !data.frame) {
      throw new Error(data.error ?? "El sidecar no pudo procesar el frame.");
    }

    return data.frame;
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(
        `El frame IA agotó ${timeoutLabel(FRAME_PROCESS_TIMEOUT_MS)} sin respuesta del procesador.`,
      );
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function processAiAudio(
  sessionId: string,
  input: AiAudioProcessInput,
): Promise<AiAudioProcessResult> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    AUDIO_PROCESS_TIMEOUT_MS,
  );

  try {
    const response = await fetch(
      `${aiSidecarUrl()}/sessions/${encodeURIComponent(sessionId)}/audio`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        signal: controller.signal,
      },
    );
    const data = (await response.json().catch(() => ({}))) as {
      audio?: AiAudioProcessResult;
      error?: string;
    };

    if (!response.ok || !data.audio) {
      throw new Error(data.error ?? "El sidecar no pudo procesar audio.");
    }

    return data.audio;
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(
        `El audio IA agotó ${timeoutLabel(AUDIO_PROCESS_TIMEOUT_MS)} sin respuesta del procesador.`,
      );
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function isAbortError(error: unknown) {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error as { name?: string }).name === "AbortError")
  );
}

function timeoutLabel(timeoutMs: number) {
  return `${Math.round(timeoutMs / 1000)}s`;
}

export async function getAiSession(sessionId: string): Promise<AiSession> {
  const response = await fetch(
    `${aiSidecarUrl()}/sessions/${encodeURIComponent(sessionId)}`,
  );
  const data = (await response.json().catch(() => ({}))) as {
    session?: AiSession;
    error?: string;
  };

  if (!response.ok || !data.session) {
    throw new Error(
      data.error ?? "No se pudo consultar la sesión local de IA.",
    );
  }

  return data.session;
}

export async function stopAiSession(sessionId: string): Promise<void> {
  await fetch(`${aiSidecarUrl()}/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  }).catch(() => undefined);
}

export function aiSidecarUrl() {
  return (
    (import.meta.env.VITE_SHAPE_AI_SERVICE_URL as string | undefined) ??
    DEFAULT_AI_SIDECAR_URL
  );
}
