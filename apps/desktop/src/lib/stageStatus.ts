import type {
  AiDiagnostics,
  AiSession,
  AiStageState,
  AiVoiceRuntimeStatus,
} from "./aiSidecar";

export type AiStageId = "face" | "background" | "voice";
export type StageNoticeTone = "info" | "warning" | "error";

export interface AiEffectSelection {
  face: boolean;
  background: boolean;
  voice: boolean;
}

export interface StageStatusNotice {
  id: AiStageId;
  label: string;
  tone: StageNoticeTone;
  title: string;
  message: string;
  action?: string;
  reason: string | null;
  state: string | null;
}

export interface StageDiagnosticRow {
  id: AiStageId;
  label: string;
  enabled: boolean;
  state: string;
  reason: string;
  detail: string;
  device: string;
  latency: string;
  vram: string;
  voiceRuntime: string;
}

export interface EffectFallbackStatus {
  title: string;
  message: string;
  tone: "warning" | "error";
}

const STAGE_IDS: AiStageId[] = ["face", "background", "voice"];

const STAGE_LABELS: Record<AiStageId, string> = {
  face: "Rostro",
  background: "Fondo",
  voice: "Voz",
};

const STAGE_PRODUCT_NAMES: Record<AiStageId, string> = {
  face: "el rostro",
  background: "el fondo",
  voice: "la voz",
};

const REASON_MESSAGES: Record<string, string> = {
  audio_format_unsupported: "El formato de audio no es compatible",
  background_clean_plate_missing: "Falta la calibración del fondo",
  bmv2_model_missing: "El motor no pudo cargarse",
  clean_plate_missing: "Falta la calibración del fondo",
  coreml_fallback_cpu: "Rendimiento reducido: procesando en CPU",
  engine_load_failed: "El motor no pudo cargarse",
  engine_not_loaded: "El motor todavía no está listo",
  face_source_missing: "Falta la imagen de identidad del rostro",
  face_source_not_detected:
    "No se detectó un rostro en la identidad seleccionada",
  identity_face_not_detected:
    "No se detectó un rostro en la identidad seleccionada",
  inference_failed: "El procesamiento falló",
  inference_timeout: "El procesamiento está tardando demasiado",
  inswapper_model_missing: "El motor no pudo cargarse",
  rvm_model_missing: "El motor no pudo cargarse",
  vcclient_bootstrap_failed: "No se pudo cargar tu voz",
  vcclient_crash_loop: "El motor de voz no pudo mantenerse activo",
  vcclient_starting: "La voz se está preparando (puede tardar un minuto)",
  vram_oom: "La tarjeta gráfica se quedó sin memoria",
  wokada_bad_response: "El motor de voz no responde",
  wokada_not_configured: "La voz no está configurada",
  wokada_unreachable: "El motor de voz no responde",
};

export function stageReasonMessage(
  reason: string | null | undefined,
  stage: AiStageId,
  state?: string | null,
) {
  const normalizedReason = normalizeReason(reason);
  if (normalizedReason && REASON_MESSAGES[normalizedReason]) {
    return REASON_MESSAGES[normalizedReason];
  }

  if (state === "failed") {
    return `No se pudo aplicar ${STAGE_PRODUCT_NAMES[stage]}`;
  }

  if (state === "degraded") {
    return `${capitalize(STAGE_PRODUCT_NAMES[stage])} se está aplicando con limitaciones`;
  }

  return `${capitalize(STAGE_PRODUCT_NAMES[stage])} necesita revisión`;
}

export function buildStageStatusNotices({
  session,
  diagnostics,
  enabled,
}: {
  session: AiSession | null;
  diagnostics?: AiDiagnostics | null;
  enabled: AiEffectSelection;
}): StageStatusNotice[] {
  return STAGE_IDS.flatMap((stage) => {
    if (!enabled[stage]) return [];

    const status = stageStatusFromSources(session, diagnostics ?? null, stage);
    const voiceRuntime =
      stage === "voice" ? diagnostics?.modelEndpoint.voiceRuntime : null;
    const reason = normalizeReason(status.reason ?? voiceRuntime?.reason);

    if (stage === "voice" && isVoicePreparing(reason, voiceRuntime ?? null)) {
      return [voicePreparingNotice(reason)];
    }

    if (stage === "voice" && isVoiceCrashLoop(reason, voiceRuntime ?? null)) {
      return [
        stageNotice(stage, "failed", reason ?? "vcclient_crash_loop", "error"),
      ];
    }

    if (status.state === "failed") {
      return [stageNotice(stage, status.state, reason, "error")];
    }

    if (status.state === "degraded") {
      return [stageNotice(stage, status.state, reason, "warning")];
    }

    return [];
  });
}

export function buildVoicePreparingNotice(): StageStatusNotice {
  return voicePreparingNotice("vcclient_starting");
}

export function buildStageDiagnosticRows({
  session,
  diagnostics,
  enabled,
}: {
  session: AiSession | null;
  diagnostics?: AiDiagnostics | null;
  enabled: AiEffectSelection;
}): StageDiagnosticRow[] {
  const voiceRuntime = diagnostics?.modelEndpoint.voiceRuntime ?? null;

  return STAGE_IDS.map((stage) => {
    const status = stageStatusFromSources(session, diagnostics ?? null, stage);

    return {
      id: stage,
      label: STAGE_LABELS[stage],
      enabled: enabled[stage],
      state: status.state ?? (enabled[stage] ? "sin_estado" : "sin_activar"),
      reason: status.reason ?? "—",
      detail: status.detail ?? "—",
      device: status.device ?? "—",
      latency: formatLatency(status.latencyMs),
      vram: formatVram(status.vramMb),
      voiceRuntime: stage === "voice" ? voiceRuntimeLabel(voiceRuntime) : "—",
    };
  });
}

export function buildProcessedVideoFallbackStatus(
  status: { state: string; reason: string | null } | null,
  enabled: Pick<AiEffectSelection, "face" | "background">,
): EffectFallbackStatus | null {
  if (!enabled.face && !enabled.background) return null;
  if (!status || !["degraded", "fallback"].includes(status.state)) return null;

  const stage = stageFromReason(status.reason, enabled);
  const state = status.state === "fallback" ? "failed" : "degraded";
  const message = stageReasonMessage(status.reason, stage, state);

  return {
    title: "Cámara sin efectos",
    message,
    tone: status.state === "fallback" ? "error" : "warning",
  };
}

function stageNotice(
  stage: AiStageId,
  state: "degraded" | "failed",
  reason: string | null,
  tone: StageNoticeTone,
): StageStatusNotice {
  const productName = STAGE_PRODUCT_NAMES[stage];

  return {
    id: stage,
    label: STAGE_LABELS[stage],
    tone,
    title:
      state === "failed"
        ? `${capitalize(productName)} no se está aplicando`
        : `${STAGE_LABELS[stage]} con aviso`,
    message: stageReasonMessage(reason, stage, state),
    action: state === "failed" ? "Revisar diagnóstico" : undefined,
    reason,
    state,
  };
}

function voicePreparingNotice(reason: string | null): StageStatusNotice {
  return {
    id: "voice",
    label: STAGE_LABELS.voice,
    tone: "info",
    title: "Preparando la voz…",
    message: stageReasonMessage(reason ?? "vcclient_starting", "voice"),
    reason: reason ?? "vcclient_starting",
    state: "degraded",
  };
}

function stageStatusFromSources(
  session: AiSession | null,
  diagnostics: AiDiagnostics | null,
  stage: AiStageId,
) {
  const pipeline = session?.pipelines.find((item) => item.id === stage);
  const diagnosticStage = diagnostics?.modelEndpoint.stages.find(
    (item) => item.id === stage || item.kind === stage,
  );

  return {
    state:
      normalizeStageState(pipeline?.state) ??
      normalizeStageState(diagnosticStage?.engine?.state) ??
      normalizeStageState(pipeline?.status) ??
      normalizeStageState(diagnosticStage?.status) ??
      null,
    reason:
      normalizeReason(pipeline?.reason) ??
      normalizeReason(diagnosticStage?.engine?.reason),
    detail: pipeline?.stateDetail ?? diagnosticStage?.engine?.detail ?? null,
    device:
      normalizeMetricText(pipeline?.stageDevice) ??
      normalizeMetricText(diagnosticStage?.engine?.device),
    latencyMs:
      normalizeNumber(pipeline?.latencyMs) ??
      normalizeNumber(diagnosticStage?.engine?.lastLatencyMs),
    vramMb:
      normalizeNumber(pipeline?.stageVramMb) ??
      normalizeNumber(diagnosticStage?.engine?.vramMb),
  } satisfies {
    state: string | null;
    reason: string | null;
    detail: string | null;
    device: string | null;
    latencyMs: number | null;
    vramMb: number | null;
  };
}

function normalizeStageState(
  value: AiStageState | string | null | undefined,
): string | null {
  const normalized = normalizeMetricText(value)?.toLowerCase();
  if (!normalized) return null;
  if (["failed", "error", "dead"].includes(normalized)) return "failed";
  if (["degraded", "limited", "warning", "warn"].includes(normalized))
    return "degraded";
  if (
    ["active", "ready", "running", "processed", "healthy"].includes(normalized)
  )
    return "active";
  if (["standby", "stopped", "offline", "idle"].includes(normalized))
    return normalized;
  return normalized;
}

function normalizeReason(value: string | null | undefined) {
  const normalized = normalizeMetricText(value);
  return normalized && normalized !== "none" ? normalized : null;
}

function normalizeMetricText(value: string | null | undefined) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function normalizeNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isVoicePreparing(
  reason: string | null,
  runtime: AiVoiceRuntimeStatus | null,
) {
  if (reason === "vcclient_starting") return true;
  if (!runtime?.managed || runtime.running) return false;
  return !isVoiceCrashLoop(reason ?? runtime.reason, runtime);
}

function isVoiceCrashLoop(
  reason: string | null | undefined,
  runtime: AiVoiceRuntimeStatus | null,
) {
  return (
    normalizeReason(reason) === "vcclient_crash_loop" ||
    runtime?.state === "crash_loop" ||
    runtime?.reason === "vcclient_crash_loop"
  );
}

function voiceRuntimeLabel(runtime: AiVoiceRuntimeStatus | null) {
  if (!runtime) return "—";

  return `managed=${runtime.managed ? "true" : "false"} · running=${
    runtime.running ? "true" : "false"
  } · restarts=${runtime.restarts}`;
}

function formatLatency(value: number | null) {
  return value === null ? "—" : `${Math.round(value)} ms`;
}

function formatVram(value: number | null) {
  return value === null ? "—" : `${Math.round(value)} MB`;
}

function stageFromReason(
  reason: string | null,
  enabled: Pick<AiEffectSelection, "face" | "background">,
): AiStageId {
  if (
    reason &&
    ["clean_plate_missing", "background_clean_plate_missing"].includes(reason)
  ) {
    return "background";
  }

  if (
    reason &&
    [
      "face_source_missing",
      "face_source_not_detected",
      "identity_face_not_detected",
    ].includes(reason)
  ) {
    return "face";
  }

  if (enabled.face) return "face";
  return "background";
}

function capitalize(value: string) {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
