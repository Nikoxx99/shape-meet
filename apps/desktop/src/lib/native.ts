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

export interface NativeDesktopRuntimeConfig {
  apiBaseUrl: string;
  appBaseUrl: string;
  meetingBaseUrl: string;
  aiServiceUrl: string;
  hostIdentifier: string | null;
  demoDataEnabled: boolean;
  sentryDsn: string | null;
  sentryEnvironment: string;
  sentryRelease: string;
  sentryTracesSampleRate: number;
  sentryDebug: boolean;
  configPath: string | null;
  warnings: string[];
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

export interface NativeAiRuntimeDoctorReport {
  ok: boolean;
  status: string;
  profile: string;
  runtimePath: string;
  runtimeExists: boolean;
  passthroughEnabled: boolean;
  realModelsConfigured: boolean;
  checks: NativeAiRuntimeDoctorCheck[];
  nextSteps: string[];
}

export interface NativeAiRuntimeDoctorCheck {
  id: string;
  label: string;
  status: string;
  message: string;
}

export interface NativeDemoAiRuntimeInput {
  videoProcessorPort?: string | null;
  audioProcessorPort?: string | null;
}

export interface NativeModelAiRuntimeInput {
  runtimePreset?: string | null;
  workstationProfile?: string | null;
  wrapperPassthrough: boolean;
  videoProcessorPort?: string | null;
  audioProcessorPort?: string | null;
  modelEndpointHost?: string | null;
  modelEndpointPort?: string | null;
  videoFrameEndpoint?: string | null;
  faceEndpoint?: string | null;
  backgroundEndpoint?: string | null;
  audioChunkEndpoint?: string | null;
  voiceEndpoint?: string | null;
  facefusionDir?: string | null;
  facefusionPython?: string | null;
  facefusionProviders?: string | null;
  facefusionProcessors?: string | null;
  facefusionExtraArgs?: string | null;
  bmv2RepoDir?: string | null;
  bmv2Python?: string | null;
  bmv2Checkpoint?: string | null;
  bmv2Device?: string | null;
  bmv2ExtraArgs?: string | null;
  vcclient000HttpEndpoint?: string | null;
  vcclient000HttpMode?: string | null;
  modelTimeoutSecs?: string | null;
  processorTimeoutSecs?: string | null;
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

export type NativeDemoReadinessStatus = "ready" | "warning" | "blocked";

export type NativeDemoReadinessCheckStatus =
  "ok" | "warning" | "blocked" | "pending";

export interface NativeDemoReadinessCheck {
  id: string;
  label: string;
  status: NativeDemoReadinessCheckStatus;
  detail: string;
}

export interface NativeDemoReadinessReport {
  checkedAt: string;
  percent: number;
  status: NativeDemoReadinessStatus;
  summary: string;
  checks: NativeDemoReadinessCheck[];
  nextSteps: string[];
}

let desktopRuntimeConfigCache: NativeDesktopRuntimeConfig | null = null;
let desktopRuntimeConfigPromise: Promise<NativeDesktopRuntimeConfig> | null =
  null;

export async function getGpuProfile(): Promise<NativeGpuProfile> {
  try {
    return await invoke<NativeGpuProfile>("get_gpu_profile");
  } catch {
    return {
      platform: "browser",
      arch: "unknown",
      gpuTier: "limited",
      message:
        "Modo UI: el diagnostico GPU completo esta disponible dentro de Tauri.",
      nvidiaSmiAvailable: false,
      cudaAvailable: false,
      cudaVersion: null,
      driverVersion: null,
      totalVramMb: null,
      freeVramMb: null,
      minimumRequiredVramMb: 8192,
      recommendedVramMb: 24576,
      devices: [],
      warnings: ["Runtime nativo no disponible."],
    };
  }
}

export function getCachedDesktopRuntimeConfig(): NativeDesktopRuntimeConfig {
  return desktopRuntimeConfigCache ?? fallbackDesktopRuntimeConfig();
}

export async function getDesktopRuntimeConfig(): Promise<NativeDesktopRuntimeConfig> {
  if (desktopRuntimeConfigCache) return desktopRuntimeConfigCache;
  if (desktopRuntimeConfigPromise) return desktopRuntimeConfigPromise;

  desktopRuntimeConfigPromise = invoke<NativeDesktopRuntimeConfig>(
    "get_desktop_runtime_config",
  )
    .catch(() => fallbackDesktopRuntimeConfig())
    .then((config) => {
      desktopRuntimeConfigCache = normalizeDesktopRuntimeConfig(config);
      return desktopRuntimeConfigCache;
    })
    .finally(() => {
      desktopRuntimeConfigPromise = null;
    });

  return desktopRuntimeConfigPromise;
}

export async function getObservabilityStatus(): Promise<NativeObservabilityStatus> {
  const frontend = frontendObservabilityStatus();

  try {
    const native = await invoke<
      Omit<NativeObservabilityStatus, "frontendSentryEnabled">
    >("get_observability_status");
    return {
      ...native,
      frontendSentryEnabled: frontend.enabled,
    };
  } catch {
    return {
      nativeSentryEnabled: false,
      frontendSentryEnabled: frontend.enabled,
      environment: frontend.environment,
      release: frontend.release,
      tracesSampleRate: frontend.tracesSampleRate,
      debug: false,
    };
  }
}

export async function getDemoReadiness(): Promise<NativeDemoReadinessReport> {
  const checkedAt = new Date().toISOString();
  const config = await getDesktopRuntimeConfig();
  const [
    api,
    service,
    sidecarRuntime,
    endpointRuntime,
    gpu,
    observability,
    doctor,
  ] = await Promise.all([
    checkApiHealth(config.apiBaseUrl),
    getAiServiceStatus(),
    getAiSidecarRuntime(),
    getModelEndpointRuntime(),
    getGpuProfile(),
    getObservabilityStatus(),
    doctorAiRuntimeEnv(),
  ]);

  const scoredChecks: Array<NativeDemoReadinessCheck & { score: number }> = [
    {
      id: "api",
      label: "API",
      status: api.ok ? "ok" : "blocked",
      detail: api.detail,
      score: api.ok ? 15 : 0,
    },
    {
      id: "ai-service",
      label: "IA local",
      status: service.online ? "ok" : "blocked",
      detail: service.online ? service.mode : service.message,
      score: service.online ? 15 : 0,
    },
    {
      id: "gpu",
      label: "GPU",
      status: gpu.gpuTier === "ready" ? "ok" : "warning",
      detail: gpuDeviceSummary(gpu),
      score: gpu.gpuTier === "ready" ? 10 : gpu.gpuTier === "limited" ? 8 : 0,
    },
    {
      id: "sentry",
      label: "Sentry",
      status:
        observability.frontendSentryEnabled || observability.nativeSentryEnabled
          ? "ok"
          : "warning",
      detail:
        observability.frontendSentryEnabled && observability.nativeSentryEnabled
          ? "Web y nativo"
          : observability.frontendSentryEnabled
            ? "Web"
            : observability.nativeSentryEnabled
              ? "Nativo"
              : "Sin DSN",
      score:
        observability.frontendSentryEnabled && observability.nativeSentryEnabled
          ? 10
          : observability.frontendSentryEnabled ||
              observability.nativeSentryEnabled
            ? 7
            : 0,
    },
    {
      id: "runtime",
      label: "Runtime",
      status: doctor.ok ? "ok" : "warning",
      detail: doctor.runtimeExists ? doctor.status : "Sin archivo",
      score: doctor.ok ? 15 : doctor.runtimeExists ? 8 : 0,
    },
    {
      id: "processors",
      label: "Procesos",
      status: sidecarRuntime.running
        ? endpointRuntime.running
          ? "ok"
          : "warning"
        : "blocked",
      detail: processorReadinessDetail(sidecarRuntime, endpointRuntime),
      score:
        (sidecarRuntime.running ? 8 : 0) +
        (endpointRuntime.running ? 7 : service.online ? 3 : 0),
    },
    {
      id: "real-models",
      label: "Modelos",
      status: doctor.realModelsConfigured
        ? "ok"
        : doctor.passthroughEnabled
          ? "warning"
          : "blocked",
      detail: doctor.realModelsConfigured
        ? "Reales"
        : doctor.passthroughEnabled
          ? "Passthrough"
          : "Pendientes",
      score: doctor.realModelsConfigured
        ? 20
        : doctor.passthroughEnabled
          ? 7
          : 0,
    },
  ];

  const percent = Math.max(
    0,
    Math.min(
      100,
      Math.round(scoredChecks.reduce((total, check) => total + check.score, 0)),
    ),
  );
  const checks = scoredChecks.map(({ score: _score, ...check }) => check);
  const status: NativeDemoReadinessStatus = checks.some(
    (check) => check.status === "blocked",
  )
    ? "blocked"
    : checks.some((check) => check.status === "warning")
      ? "warning"
      : "ready";

  return {
    checkedAt,
    percent,
    status,
    summary: `${percent}% · ${demoReadinessStatusLabel(status)}`,
    checks,
    nextSteps: demoReadinessNextSteps(checks, doctor),
  };
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

export async function getModelEndpointRuntime(): Promise<NativeAiSidecarRuntime> {
  try {
    return await invoke<NativeAiSidecarRuntime>("get_model_endpoint_runtime");
  } catch {
    return browserModelEndpointRuntime(false);
  }
}

export async function startAiSidecar(): Promise<NativeAiSidecarRuntime> {
  try {
    return await invoke<NativeAiSidecarRuntime>("start_ai_sidecar");
  } catch {
    const service = await getBrowserAiServiceStatus();
    return {
      ...browserSidecarRuntime(service),
      message: service.online
        ? "Sidecar externo detectado."
        : "Disponible solo dentro de Tauri.",
    };
  }
}

export async function startModelEndpoint(input?: {
  passthrough?: boolean | null;
  demoEffects?: boolean | null;
}): Promise<NativeAiSidecarRuntime> {
  try {
    return await invoke<NativeAiSidecarRuntime>("start_model_endpoint", {
      input: input ?? null,
    });
  } catch {
    return {
      ...browserModelEndpointRuntime(false),
      message: "Servidor de endpoints disponible solo dentro de Tauri.",
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
      message: service.online
        ? "El navegador no puede detener el sidecar externo."
        : "Disponible solo dentro de Tauri.",
    };
  }
}

export async function stopModelEndpoint(): Promise<NativeAiSidecarRuntime> {
  try {
    return await invoke<NativeAiSidecarRuntime>("stop_model_endpoint");
  } catch {
    return {
      ...browserModelEndpointRuntime(false),
      message: "El navegador no puede detener endpoints locales.",
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
      warnings: ["Config IA local disponible solo dentro de Tauri."],
    };
  }
}

export async function doctorAiRuntimeEnv(): Promise<NativeAiRuntimeDoctorReport> {
  try {
    return await invoke<NativeAiRuntimeDoctorReport>("doctor_ai_runtime_env");
  } catch {
    return {
      ok: false,
      status: "warning",
      profile: "browser",
      runtimePath: "",
      runtimeExists: false,
      passthroughEnabled: true,
      realModelsConfigured: false,
      checks: [
        {
          id: "native-runtime",
          label: "Runtime",
          status: "warn",
          message: "Doctor IA local disponible dentro de Tauri.",
        },
      ],
      nextSteps: ["Abre la app Tauri para diagnosticar modelos reales."],
    };
  }
}

export async function saveAiRuntimeEnv(
  content: string,
): Promise<NativeAiRuntimeEnvFile> {
  try {
    return await invoke<NativeAiRuntimeEnvFile>("save_ai_runtime_env", {
      input: { content },
    });
  } catch (error) {
    return {
      path: "",
      exists: false,
      content,
      configuredKeys: [],
      warnings: [
        error instanceof Error
          ? error.message
          : "No se pudo guardar la config IA local.",
      ],
    };
  }
}

export async function prepareDemoAiRuntimeEnv(
  input?: NativeDemoAiRuntimeInput,
): Promise<NativeAiRuntimeEnvFile> {
  try {
    return await invoke<NativeAiRuntimeEnvFile>("prepare_demo_ai_runtime_env", {
      input: input ?? null,
    });
  } catch (error) {
    return {
      path: "",
      exists: false,
      content: "",
      configuredKeys: [],
      warnings: [
        error instanceof Error
          ? error.message
          : "Preset IA local disponible solo dentro de Tauri.",
      ],
    };
  }
}

export async function prepareModelAiRuntimeEnv(
  input?: NativeModelAiRuntimeInput,
): Promise<NativeAiRuntimeEnvFile> {
  try {
    return await invoke<NativeAiRuntimeEnvFile>(
      "prepare_model_ai_runtime_env",
      {
        input: input ?? null,
      },
    );
  } catch (error) {
    return {
      path: "",
      exists: false,
      content: "",
      configuredKeys: [],
      warnings: [
        error instanceof Error
          ? error.message
          : "Runtime de wrappers disponible solo dentro de Tauri.",
      ],
    };
  }
}

export async function cacheIdentityArtifact(
  identity: Pick<
    HostIdentity,
    "id" | "artifactUri" | "artifactSha256" | "artifactSizeBytes"
  >,
): Promise<NativeIdentityArtifactCacheResult> {
  const artifactUri = identity.artifactUri?.trim() || null;

  try {
    return await invoke<NativeIdentityArtifactCacheResult>(
      "cache_identity_artifact",
      {
        input: {
          identityId: identity.id,
          artifactUri,
          artifactSha256: identity.artifactSha256 ?? null,
          artifactSizeBytes: identity.artifactSizeBytes ?? null,
        },
      },
    );
  } catch (error) {
    if (artifactUri?.startsWith("shape://")) {
      return {
        identityId: identity.id,
        cached: false,
        localPath: null,
        uri: artifactUri,
        sha256: identity.artifactSha256 ?? null,
        sizeBytes: identity.artifactSizeBytes ?? null,
        message: "Artefacto de desarrollo sin descarga local.",
      };
    }

    return {
      identityId: identity.id,
      cached: false,
      localPath: null,
      uri: artifactUri,
      sha256: identity.artifactSha256 ?? null,
      sizeBytes: identity.artifactSizeBytes ?? null,
      message:
        error instanceof Error
          ? error.message
          : "Cache local disponible dentro de Tauri.",
    };
  }
}

export async function evictIdentityArtifact(
  identityId: string,
): Promise<NativeIdentityArtifactCacheResult> {
  try {
    return await invoke<NativeIdentityArtifactCacheResult>(
      "evict_identity_artifact",
      {
        input: { identityId },
      },
    );
  } catch (error) {
    return {
      identityId,
      cached: false,
      localPath: null,
      uri: null,
      sha256: null,
      sizeBytes: null,
      message:
        error instanceof Error
          ? error.message
          : "Evicción local disponible dentro de Tauri.",
    };
  }
}

export async function captureNativeDebugEvent(
  message: string,
): Promise<NativeDebugEventResult> {
  try {
    return await invoke<NativeDebugEventResult>("capture_native_debug_event", {
      message,
    });
  } catch {
    if (frontendObservabilityStatus().enabled) {
      const eventId = Sentry.captureMessage(message, "info");

      return {
        captured: true,
        eventId,
        message: `Evento Sentry frontend enviado: ${eventId}`,
      };
    }

    return {
      captured: false,
      eventId: null,
      message: "Evento nativo disponible solo dentro de Tauri.",
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

async function checkApiHealth(apiBaseUrl: string): Promise<{
  ok: boolean;
  detail: string;
}> {
  const endpoint = `${apiBaseUrl.replace(/\/$/, "")}/api/health`;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 1200);

  try {
    const response = await fetch(endpoint, { signal: controller.signal });
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };
    return { ok: true, detail: "Lista" };
  } catch (error) {
    return {
      ok: false,
      detail:
        error instanceof Error && error.name === "AbortError"
          ? "Timeout"
          : "Sin respuesta",
    };
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function gpuDeviceSummary(profile: NativeGpuProfile) {
  const primary = profile.devices[0];
  if (!primary) return profile.message;

  const memory = primary.memoryTotalMb
    ? `${Math.round(primary.memoryTotalMb / 1024)} GB`
    : null;
  return memory ? `${primary.name} · ${memory}` : primary.name;
}

function processorReadinessDetail(
  sidecarRuntime: NativeAiSidecarRuntime,
  endpointRuntime: NativeAiSidecarRuntime,
) {
  if (sidecarRuntime.running && endpointRuntime.running)
    return "Sidecar + endpoints";
  if (sidecarRuntime.running) return "Sidecar activo";
  if (endpointRuntime.running) return "Endpoints activos";
  return "Detenidos";
}

function demoReadinessStatusLabel(status: NativeDemoReadinessStatus) {
  if (status === "ready") return "Listo";
  if (status === "warning") return "Revisar";
  return "Bloqueado";
}

function demoReadinessNextSteps(
  checks: NativeDemoReadinessCheck[],
  doctor: NativeAiRuntimeDoctorReport,
) {
  const steps: string[] = [];
  const blocked = checks.find((check) => check.status === "blocked");
  if (blocked) steps.push(`${blocked.label}: ${blocked.detail}`);
  if (!doctor.realModelsConfigured) {
    steps.push(
      doctor.passthroughEnabled
        ? "Instala modelos reales para salir de passthrough."
        : "Configura FaceFusion, BackgroundMattingV2 y vcclient000.",
    );
  }
  for (const step of doctor.nextSteps.slice(0, 2)) {
    if (!steps.includes(step)) steps.push(step);
  }
  return steps.slice(0, 3);
}

function frontendObservabilityStatus() {
  const config = getCachedDesktopRuntimeConfig();

  return {
    enabled: Boolean(config.sentryDsn),
    environment: config.sentryEnvironment,
    release: config.sentryRelease,
    tracesSampleRate: Number.isFinite(config.sentryTracesSampleRate)
      ? config.sentryTracesSampleRate
      : 1,
  };
}

async function getBrowserAiServiceStatus(): Promise<NativeAiServiceStatus> {
  const endpoint = frontendAiSidecarUrl();
  const checkedAt = new Date().toISOString();
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 1200);

  try {
    const response = await fetch(`${endpoint.replace(/\/$/, "")}/health`, {
      signal: controller.signal,
    });
    const data = (await response
      .json()
      .catch(() => ({}))) as Partial<NativeAiServiceStatus>;

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
      pipelines: Array.isArray(data.pipelines)
        ? data.pipelines
        : defaultBrowserPipelines("standby"),
    };
  } catch (error) {
    return {
      endpoint,
      online: false,
      mode: "browser",
      status: "offline",
      message:
        error instanceof Error && error.name === "AbortError"
          ? "Sidecar local no respondió."
          : "Sidecar local no disponible.",
      checkedAt,
      pipelines: defaultBrowserPipelines("offline"),
    };
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function defaultBrowserPipelines(
  status: "standby" | "offline",
): NativeAiPipelineStatus[] {
  const detail =
    status === "offline" ? "Esperando sidecar local." : "Contrato local listo.";

  return [
    {
      id: "face",
      label: "Rostro",
      status,
      model: "FaceFusion / DFM",
      detail,
      latencyMs: null,
    },
    {
      id: "background",
      label: "Fondo",
      status,
      model: "BackgroundMattingV2",
      detail,
      latencyMs: null,
    },
    {
      id: "voice",
      label: "Voz",
      status,
      model: "vcclient000",
      detail,
      latencyMs: null,
    },
  ];
}

function frontendAiSidecarUrl() {
  return getCachedDesktopRuntimeConfig().aiServiceUrl;
}

function browserSidecarRuntime(
  service: NativeAiServiceStatus,
): NativeAiSidecarRuntime {
  return {
    endpoint: service.endpoint,
    managed: false,
    running: service.online,
    pid: null,
    command: null,
    logPath: "",
    message: service.online ? "Sidecar externo detectado." : service.message,
    lastExit: null,
  };
}

function browserModelEndpointRuntime(running: boolean): NativeAiSidecarRuntime {
  return {
    endpoint: "http://127.0.0.1:9100",
    managed: false,
    running,
    pid: null,
    command: null,
    logPath: "",
    message: running
      ? "Servidor de endpoints externo detectado."
      : "Endpoints locales disponibles dentro de Tauri.",
    lastExit: null,
  };
}

function fallbackDesktopRuntimeConfig(): NativeDesktopRuntimeConfig {
  const appBaseUrl =
    (import.meta.env.VITE_SHAPE_APP_URL as string | undefined) ??
    "https://meet.shape.local";

  return normalizeDesktopRuntimeConfig({
    apiBaseUrl:
      (import.meta.env.VITE_SHAPE_API_URL as string | undefined) ??
      "http://localhost:3000",
    appBaseUrl,
    meetingBaseUrl:
      (import.meta.env.VITE_SHAPE_MEETING_URL as string | undefined) ??
      appBaseUrl,
    aiServiceUrl:
      (import.meta.env.VITE_SHAPE_AI_SERVICE_URL as string | undefined) ??
      "http://127.0.0.1:7851",
    hostIdentifier:
      (import.meta.env.VITE_SHAPE_HOST_IDENTIFIER as string | undefined) ??
      null,
    demoDataEnabled:
      String(import.meta.env.VITE_SHAPE_DEMO_DATA ?? "").toLowerCase() ===
      "true",
    sentryDsn: (import.meta.env.VITE_SENTRY_DSN as string | undefined) ?? null,
    sentryEnvironment:
      (import.meta.env.VITE_SENTRY_ENVIRONMENT as string | undefined) ??
      import.meta.env.MODE,
    sentryRelease:
      (import.meta.env.VITE_SENTRY_RELEASE as string | undefined) ??
      "shape-meet-desktop@0.1.0",
    sentryTracesSampleRate: Number(
      import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE ?? "1",
    ),
    sentryDebug: ["1", "true", "yes"].includes(
      String(import.meta.env.VITE_SENTRY_DEBUG ?? "").toLowerCase(),
    ),
    configPath: null,
    warnings: [],
  });
}

function normalizeDesktopRuntimeConfig(
  config: NativeDesktopRuntimeConfig,
): NativeDesktopRuntimeConfig {
  return {
    apiBaseUrl: trimTrailingSlash(config.apiBaseUrl || "http://localhost:3000"),
    appBaseUrl: trimTrailingSlash(
      config.appBaseUrl || "https://meet.shape.local",
    ),
    meetingBaseUrl: trimTrailingSlash(
      config.meetingBaseUrl || config.appBaseUrl || "https://meet.shape.local",
    ),
    aiServiceUrl: trimTrailingSlash(
      config.aiServiceUrl || "http://127.0.0.1:7851",
    ),
    hostIdentifier: config.hostIdentifier?.trim() || null,
    demoDataEnabled: Boolean(config.demoDataEnabled),
    sentryDsn: config.sentryDsn?.trim() || null,
    sentryEnvironment: config.sentryEnvironment || "development",
    sentryRelease: config.sentryRelease || "shape-meet-desktop@0.1.0",
    sentryTracesSampleRate: Number.isFinite(config.sentryTracesSampleRate)
      ? config.sentryTracesSampleRate
      : 1,
    sentryDebug: Boolean(config.sentryDebug),
    configPath: config.configPath?.trim() || null,
    warnings: Array.isArray(config.warnings) ? config.warnings : [],
  };
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/$/, "");
}
