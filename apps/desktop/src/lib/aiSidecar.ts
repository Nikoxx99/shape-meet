import type { NativeAiPipelineStatus } from "./native";

const DEFAULT_AI_SIDECAR_URL = "http://127.0.0.1:7851";

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
  const timeoutId = window.setTimeout(() => controller.abort(), 12000);

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

    if (!response.ok || !data.preflight) {
      throw new Error(
        data.error ?? "No se pudo probar el runtime local de IA.",
      );
    }

    return data.preflight;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function processAiFrame(
  sessionId: string,
  input: AiFrameProcessInput,
): Promise<AiFrameProcessResult> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 900);

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
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function processAiAudio(
  sessionId: string,
  input: AiAudioProcessInput,
): Promise<AiAudioProcessResult> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 500);

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
  } finally {
    window.clearTimeout(timeoutId);
  }
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
