import { invoke } from "@tauri-apps/api/core";
import * as Sentry from "@sentry/react";
import type { HostIdentity } from "@shape-meet/shared";

export interface NativeGpuProfile {
  platform: string;
  arch: string;
  gpuTier: "unsupported" | "limited" | "ready";
  message: string;
  nvidiaSmiAvailable: boolean;
  cudaAvailable: boolean;
  cudaVersion: string | null;
  driverVersion: string | null;
  totalVramMb: number | null;
  freeVramMb: number | null;
  minimumRequiredVramMb: number;
  recommendedVramMb: number;
  devices: NativeGpuDevice[];
  warnings: string[];
}

export interface NativeGpuDevice {
  name: string;
  memoryTotalMb: number | null;
  memoryFreeMb: number | null;
  driverVersion: string | null;
}

export interface NativeObservabilityStatus {
  nativeSentryEnabled: boolean;
  frontendSentryEnabled: boolean;
  environment: string;
  release: string;
  tracesSampleRate: number;
  debug: boolean;
}

export interface NativeDebugEventResult {
  captured: boolean;
  eventId: string | null;
  message: string;
}

export interface NativeAiPipelineStatus {
  id: string;
  label: string;
  status: "ready" | "standby" | "offline" | "error" | string;
  model: string;
  detail: string;
  latencyMs: number | null;
}

export interface NativeAiServiceStatus {
  endpoint: string;
  online: boolean;
  mode: string;
  status: string;
  message: string;
  checkedAt: string;
  pipelines: NativeAiPipelineStatus[];
}

export interface NativeAiSidecarRuntime {
  endpoint: string;
  managed: boolean;
  running: boolean;
  pid: number | null;
  command: string | null;
  logPath: string;
  message: string;
  lastExit: string | null;
}

export interface NativeAiRuntimeEnvFile {
  path: string;
  exists: boolean;
  content: string;
  configuredKeys: string[];
  warnings: string[];
}

export interface NativeIdentityArtifactCacheResult {
  identityId: string;
  cached: boolean;
  localPath: string | null;
  uri: string | null;
  sha256: string | null;
  sizeBytes: number | null;
  message: string;
}

export async function getGpuProfile(): Promise<NativeGpuProfile> {
  try {
    return await invoke<NativeGpuProfile>("get_gpu_profile");
  } catch {
    return {
      platform: "browser",
      arch: "unknown",
      gpuTier: "limited",
      message: "Modo UI: el diagnostico GPU completo esta disponible dentro de Tauri.",
      nvidiaSmiAvailable: false,
      cudaAvailable: false,
      cudaVersion: null,
      driverVersion: null,
      totalVramMb: null,
      freeVramMb: null,
      minimumRequiredVramMb: 8192,
      recommendedVramMb: 24576,
      devices: [],
      warnings: ["Runtime nativo no disponible."]
    };
  }
}

export async function getObservabilityStatus(): Promise<NativeObservabilityStatus> {
  const frontend = frontendObservabilityStatus();

  try {
    const native = await invoke<Omit<NativeObservabilityStatus, "frontendSentryEnabled">>("get_observability_status");
    return {
      ...native,
      frontendSentryEnabled: frontend.enabled
    };
  } catch {
    return {
      nativeSentryEnabled: false,
      frontendSentryEnabled: frontend.enabled,
      environment: frontend.environment,
      release: frontend.release,
      tracesSampleRate: frontend.tracesSampleRate,
      debug: false
    };
  }
}

export async function getAiServiceStatus(): Promise<NativeAiServiceStatus> {
  try {
    return await invoke<NativeAiServiceStatus>("get_ai_service_status");
  } catch {
    return getBrowserAiServiceStatus();
  }
}

export async function getAiSidecarRuntime(): Promise<NativeAiSidecarRuntime> {
  try {
    return await invoke<NativeAiSidecarRuntime>("get_ai_sidecar_runtime");
  } catch {
    const service = await getBrowserAiServiceStatus();
    return browserSidecarRuntime(service);
  }
}

export async function startAiSidecar(): Promise<NativeAiSidecarRuntime> {
  try {
    return await invoke<NativeAiSidecarRuntime>("start_ai_sidecar");
  } catch {
    const service = await getBrowserAiServiceStatus();
    return {
      ...browserSidecarRuntime(service),
      message: service.online ? "Sidecar externo detectado." : "Disponible solo dentro de Tauri."
    };
  }
}

export async function stopAiSidecar(): Promise<NativeAiSidecarRuntime> {
  try {
    return await invoke<NativeAiSidecarRuntime>("stop_ai_sidecar");
  } catch {
    const service = await getBrowserAiServiceStatus();
    return {
      ...browserSidecarRuntime(service),
      message: service.online ? "El navegador no puede detener el sidecar externo." : "Disponible solo dentro de Tauri."
    };
  }
}

export async function getAiRuntimeEnv(): Promise<NativeAiRuntimeEnvFile> {
  try {
    return await invoke<NativeAiRuntimeEnvFile>("get_ai_runtime_env");
  } catch {
    return {
      path: "",
      exists: false,
      content: "",
      configuredKeys: [],
      warnings: ["Config IA local disponible solo dentro de Tauri."]
    };
  }
}

export async function saveAiRuntimeEnv(content: string): Promise<NativeAiRuntimeEnvFile> {
  try {
    return await invoke<NativeAiRuntimeEnvFile>("save_ai_runtime_env", {
      input: { content }
    });
  } catch (error) {
    return {
      path: "",
      exists: false,
      content,
      configuredKeys: [],
      warnings: [error instanceof Error ? error.message : "No se pudo guardar la config IA local."]
    };
  }
}

export async function cacheIdentityArtifact(identity: Pick<HostIdentity, "id" | "artifactUri" | "artifactSha256" | "artifactSizeBytes">): Promise<NativeIdentityArtifactCacheResult> {
  const artifactUri = identity.artifactUri?.trim() || null;

  try {
    return await invoke<NativeIdentityArtifactCacheResult>("cache_identity_artifact", {
      input: {
        identityId: identity.id,
        artifactUri,
        artifactSha256: identity.artifactSha256 ?? null,
        artifactSizeBytes: identity.artifactSizeBytes ?? null
      }
    });
  } catch (error) {
    if (artifactUri?.startsWith("shape://")) {
      return {
        identityId: identity.id,
        cached: false,
        localPath: null,
        uri: artifactUri,
        sha256: identity.artifactSha256 ?? null,
        sizeBytes: identity.artifactSizeBytes ?? null,
        message: "Artefacto de desarrollo sin descarga local."
      };
    }

    return {
      identityId: identity.id,
      cached: false,
      localPath: null,
      uri: artifactUri,
      sha256: identity.artifactSha256 ?? null,
      sizeBytes: identity.artifactSizeBytes ?? null,
      message: error instanceof Error ? error.message : "Cache local disponible dentro de Tauri."
    };
  }
}

export async function evictIdentityArtifact(identityId: string): Promise<NativeIdentityArtifactCacheResult> {
  try {
    return await invoke<NativeIdentityArtifactCacheResult>("evict_identity_artifact", {
      input: { identityId }
    });
  } catch (error) {
    return {
      identityId,
      cached: false,
      localPath: null,
      uri: null,
      sha256: null,
      sizeBytes: null,
      message: error instanceof Error ? error.message : "Evicción local disponible dentro de Tauri."
    };
  }
}

export async function captureNativeDebugEvent(message: string): Promise<NativeDebugEventResult> {
  try {
    return await invoke<NativeDebugEventResult>("capture_native_debug_event", { message });
  } catch {
    if (frontendObservabilityStatus().enabled) {
      const eventId = Sentry.captureMessage(message, "info");

      return {
        captured: true,
        eventId,
        message: `Evento Sentry frontend enviado: ${eventId}`
      };
    }

    return {
      captured: false,
      eventId: null,
      message: "Evento nativo disponible solo dentro de Tauri."
    };
  }
}

export async function exportDebugBundle(): Promise<string> {
  try {
    return await invoke<string>("export_debug_bundle");
  } catch {
    return "Debug local disponible solo dentro de Tauri.";
  }
}

function frontendObservabilityStatus() {
  const tracesSampleRate = Number(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE ?? "1");

  return {
    enabled: Boolean(import.meta.env.VITE_SENTRY_DSN),
    environment: (import.meta.env.VITE_SENTRY_ENVIRONMENT as string | undefined) ?? import.meta.env.MODE,
    release: (import.meta.env.VITE_SENTRY_RELEASE as string | undefined) ?? "shape-meet-desktop@0.1.0",
    tracesSampleRate: Number.isFinite(tracesSampleRate) ? tracesSampleRate : 1
  };
}

async function getBrowserAiServiceStatus(): Promise<NativeAiServiceStatus> {
  const endpoint = frontendAiSidecarUrl();
  const checkedAt = new Date().toISOString();
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 1200);

  try {
    const response = await fetch(`${endpoint.replace(/\/$/, "")}/health`, {
      signal: controller.signal
    });
    const data = (await response.json().catch(() => ({}))) as Partial<NativeAiServiceStatus>;

    if (!response.ok) {
      throw new Error("health_not_ok");
    }

    return {
      endpoint,
      online: true,
      mode: data.mode ?? "browser-sidecar",
      status: data.status ?? "ready",
      message: data.message ?? "Servicio local de IA conectado.",
      checkedAt,
      pipelines: Array.isArray(data.pipelines) ? data.pipelines : defaultBrowserPipelines("standby")
    };
  } catch (error) {
    return {
      endpoint,
      online: false,
      mode: "browser",
      status: "offline",
      message: error instanceof Error && error.name === "AbortError" ? "Sidecar local no respondió." : "Sidecar local no disponible.",
      checkedAt,
      pipelines: defaultBrowserPipelines("offline")
    };
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function defaultBrowserPipelines(status: "standby" | "offline"): NativeAiPipelineStatus[] {
  const detail = status === "offline" ? "Esperando sidecar local." : "Contrato local listo.";

  return [
    {
      id: "face",
      label: "Rostro",
      status,
      model: "FaceFusion / DFM",
      detail,
      latencyMs: null
    },
    {
      id: "background",
      label: "Fondo",
      status,
      model: "BackgroundMattingV2",
      detail,
      latencyMs: null
    },
    {
      id: "voice",
      label: "Voz",
      status,
      model: "vcclient000",
      detail,
      latencyMs: null
    }
  ];
}

function frontendAiSidecarUrl() {
  return (import.meta.env.VITE_SHAPE_AI_SERVICE_URL as string | undefined) ?? "http://127.0.0.1:7851";
}

function browserSidecarRuntime(service: NativeAiServiceStatus): NativeAiSidecarRuntime {
  return {
    endpoint: service.endpoint,
    managed: false,
    running: service.online,
    pid: null,
    command: null,
    logPath: "",
    message: service.online ? "Sidecar externo detectado." : service.message,
    lastExit: null
  };
}
