import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  Calendar,
  Camera,
  Check,
  ChevronDown,
  Copy,
  KeyRound,
  Lock,
  LogIn,
  LogOut,
  Mail,
  Mic,
  MicOff,
  MonitorUp,
  Phone,
  PhoneOff,
  Plus,
  RefreshCw,
  ScreenShare,
  Send,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  User,
  Users,
  UserRound,
  Video,
  VideoOff,
  Wand2
} from "lucide-react";
import {
  defaultPipelineMetrics,
  mockIdentities,
  mockMeetings,
  mockUsers,
  type HostIdentity,
  type HostSession,
  type LiveKitConnection,
  type Meeting,
  type MeetingCreateInput,
  type PipelineMetric,
  type ShapeUser
} from "@shape-meet/shared";
import { RoomEvent, Track, type AudioCaptureOptions, type Participant, type Room, type TrackPublication, type VideoCaptureOptions } from "livekit-client";
import {
  ShapeApiError,
  admitMeetingParticipant,
  createHostMeeting,
  clearHostToken,
  endMeeting,
  extractMeetingCode,
  findMeeting,
  getCurrentHost,
  getHostIdentityArtifact,
  getStoredHostToken,
  listHostIdentities,
  listHostMeetings,
  leaveMeeting,
  loginHost,
  requestMeetingAccess,
  requestMeetingToken,
  updateMeetingParticipantMedia
} from "./lib/api";
import { getAiSession, startAiSession, stopAiSession, type AiSession } from "./lib/aiSidecar";
import { connectLiveKitRoom } from "./lib/livekit";
import {
  cacheIdentityArtifact,
  evictIdentityArtifact,
  captureNativeDebugEvent,
  exportDebugBundle,
  getAiSidecarRuntime,
  getAiServiceStatus,
  getGpuProfile,
  getObservabilityStatus,
  startAiSidecar,
  stopAiSidecar,
  type NativeAiSidecarRuntime,
  type NativeIdentityArtifactCacheResult,
  type NativeAiServiceStatus,
  type NativeGpuProfile,
  type NativeObservabilityStatus
} from "./lib/native";
import { createProcessedAudioPipeline, type ProcessedAudioPipeline, type ProcessedAudioRuntimeStatus } from "./lib/processedAudio";
import { createProcessedVideoPipeline, type ProcessedVideoPipeline, type ProcessedVideoRuntimeStatus } from "./lib/processedVideo";
import {
  normalizeDeviceSelection,
  readStoredDeviceSelection,
  useMediaDevices,
  writeStoredDeviceSelection,
  type DeviceSelection,
  type MediaDeviceChoice
} from "./lib/useMediaDevices";
import { useCameraPreview } from "./lib/useCameraPreview";

type Route =
  | "home"
  | "join"
  | "found"
  | "login"
  | "verify"
  | "denied"
  | "scheduled"
  | "meeting-detail"
  | "create"
  | "created"
  | "device-test"
  | "host-settings"
  | "background-calibration"
  | "waiting"
  | "call";

type LiveKitVideoTrack = NonNullable<TrackPublication["videoTrack"]>;
type LiveKitAudioTrack = NonNullable<TrackPublication["audioTrack"]>;
type DeviceChoices = Record<"audioinput" | "audiooutput" | "videoinput", MediaDeviceChoice[]>;

interface CallTile {
  id: string;
  identity: string;
  label: string;
  role: Meeting["participants"][number]["role"];
  isLocal: boolean;
  source: "camera" | "screen";
  cameraOn: boolean;
  micOn: boolean;
  videoTrack?: LiveKitVideoTrack;
  audioTrack?: LiveKitAudioTrack;
  effects?: { faceEnabled: boolean; backgroundEnabled: boolean; voiceEnabled: boolean };
}

interface CallChatMessage {
  id: string;
  participantId: string;
  displayName: string;
  body: string;
  sentAt: string;
  local: boolean;
}

interface BackgroundCalibration {
  cleanPlateDataUrl: string;
  capturedAt: string;
  width: number;
  height: number;
  cameraDeviceId: string;
}

const DEMO_DATA_ENABLED = import.meta.env.DEV && (import.meta.env.VITE_SHAPE_DEMO_DATA as string | undefined) !== "false";
const initialMeetings = DEMO_DATA_ENABLED ? mockMeetings : [];
const initialIdentities = DEMO_DATA_ENABLED ? mockIdentities : [];
const initialDeepLinkCode = readMeetingCodeFromLocation();
const initialMeeting = initialMeetings.find((meeting) => meeting.code === initialDeepLinkCode) ?? initialMeetings[0] ?? null;
const initialIdentity = initialIdentities.find((identity) => identity.deliveryStatus === "PUSHED") ?? initialIdentities[0] ?? null;
const initialHostIdentifier = DEMO_DATA_ENABLED ? "nicolas@luxora.co" : "";
const initialGuestName = DEMO_DATA_ENABLED ? "Maria R." : "";
const initialGuestEmail = DEMO_DATA_ENABLED ? "maria@luxora.co" : "";
const CALL_CHAT_TOPIC = "shape-meet.chat.v1";

function readMeetingCodeFromLocation() {
  if (typeof window === "undefined") return "";

  const url = new URL(window.location.href);
  const candidates = [
    url.pathname,
    url.hash,
    url.searchParams.get("code") ?? "",
    url.searchParams.get("meeting") ?? ""
  ];

  for (const candidate of candidates) {
    const code = extractMeetingCode(decodeURIComponent(candidate));
    if (/^SM-\d{3}-\d{3}$/.test(code)) return code;
  }

  return "";
}

function findInitialMeeting(codeOrUrl: string) {
  const code = extractMeetingCode(codeOrUrl);
  return initialMeetings.find((meeting) => meeting.code === code) ?? null;
}

function canUseDemoHostFallback(error: unknown, identifier: string, password: string) {
  if (!DEMO_DATA_ENABLED) return false;
  if (error instanceof ShapeApiError && error.code === "NOT_HOST") return false;
  if (error instanceof ShapeApiError && error.status !== 401 && error.status < 500) return false;
  if (password.length < 8) return false;

  const normalized = identifier.trim().toLowerCase();
  return normalized === initialHostIdentifier || normalized === "nicolas";
}

function canUseDemoRuntimeFallback(error: unknown) {
  if (!DEMO_DATA_ENABLED) return false;
  if (!(error instanceof ShapeApiError)) return true;
  if (error.status === 404) return true;
  return error.status >= 500;
}

function createDemoMeeting(input: MeetingCreateInput, host: ShapeUser | null): Meeting {
  const now = Date.now();
  const suffix = String(now % 1000000).padStart(6, "0");
  const hostUser = host ?? mockUsers.find((user) => user.rank === "HOST") ?? mockUsers[0]!;

  return {
    id: `meet_demo_${now}`,
    title: input.title,
    code: `SM-${suffix.slice(0, 3)}-${suffix.slice(3)}`,
    startsAt: input.startsAt,
    hostId: hostUser.id,
    access: input.access,
    status: "SCHEDULED",
    maxParticipants: input.maxParticipants,
    invitedEmails: input.invitedEmails ?? [],
    participants: [
      {
        id: `p_${hostUser.id}`,
        displayName: hostUser.username,
        email: hostUser.email,
        role: "host",
        mic: "on",
        camera: "on",
        aiEffects: { faceSwap: false, background: true, voice: false }
      }
    ]
  };
}

function formatMeetingTime(value: string) {
  if (!value.includes("T")) return value;

  return new Intl.DateTimeFormat("es-CO", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Bogota"
  }).format(new Date(value));
}

function initials(value: string) {
  const letters = value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join("");

  return letters || "SM";
}

function formatCaptureTime(value: string) {
  return new Intl.DateTimeFormat("es-CO", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Bogota"
  }).format(new Date(value));
}

function meetingHostName(meeting: Meeting) {
  return meeting.participants.find((participant) => participant.role === "host")?.displayName ?? "Host";
}

function meetingGuestNames(meeting: Meeting) {
  const guests = meeting.participants.filter((participant) => participant.role !== "host").map((participant) => participant.displayName);
  return guests.length > 0 ? guests.join(", ") : "Sin invitados";
}

function gpuProfileLabel(profile: NativeGpuProfile | null) {
  if (!profile) return "Detectando";
  if (profile.gpuTier === "ready") return "Lista";
  if (profile.platform === "browser") return "Modo UI";
  if (profile.devices.length > 0) return "Limitada";
  return "Sin NVIDIA";
}

function gpuTone(profile: NativeGpuProfile | null): "ok" | "warning" | "idle" {
  if (!profile) return "idle";
  return profile.gpuTier === "ready" ? "ok" : "warning";
}

function gpuDeviceLabel(profile: NativeGpuProfile | null) {
  const primary = profile?.devices[0];
  if (!primary) return null;

  const total = primary.memoryTotalMb ? `${Math.round(primary.memoryTotalMb / 1024)} GB` : null;
  return total ? `${primary.name} · ${total}` : primary.name;
}

function gpuVramLabel(profile: NativeGpuProfile | null) {
  if (!profile?.totalVramMb) return null;
  const total = `${Math.round(profile.totalVramMb / 1024)} GB`;
  const free = profile.freeVramMb ? `${Math.round(profile.freeVramMb / 1024)} GB libres` : null;
  return free ? `${total} · ${free}` : total;
}

function gpuCudaLabel(profile: NativeGpuProfile | null) {
  if (!profile) return null;
  if (profile.cudaVersion) return `CUDA ${profile.cudaVersion}${profile.driverVersion ? ` · Driver ${profile.driverVersion}` : ""}`;
  if (profile.nvidiaSmiAvailable) return profile.driverVersion ? `Driver ${profile.driverVersion}` : "Sin CUDA reportada";
  return null;
}

type AgendaFilter = "today" | "week" | "all";

const agendaFilters: { id: AgendaFilter; label: string }[] = [
  { id: "today", label: "Hoy" },
  { id: "week", label: "Semana" },
  { id: "all", label: "Todas" }
];

const bogotaDayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Bogota",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

const bogotaDateTimeFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Bogota",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});

function parseMeetingDate(value: string | Date) {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }

  const parsed = new Date(value);
  if (Number.isFinite(parsed.getTime())) return parsed;

  const normalized = value.trim().toLowerCase();
  if (normalized.startsWith("hoy")) return new Date();
  if (normalized.startsWith("mañana") || normalized.startsWith("manana")) {
    return new Date(Date.now() + 24 * 60 * 60 * 1000);
  }

  return null;
}

function meetingTimestamp(meeting: Meeting) {
  return parseMeetingDate(meeting.startsAt)?.getTime() ?? 0;
}

function meetingDayKey(value: string | Date) {
  const date = parseMeetingDate(value);
  return date ? bogotaDayFormatter.format(date) : "sin-fecha";
}

function bogotaDateTimeInputValue(value: Date) {
  const parts = Object.fromEntries(bogotaDateTimeFormatter.formatToParts(value).map((part) => [part.type, part.value]));
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}`;
}

function bogotaDateTimeInputToIso(value: string) {
  const parsed = new Date(`${value}:00-05:00`);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
}

function defaultMeetingStartInput() {
  return bogotaDateTimeInputValue(new Date(Date.now() + 30 * 60 * 1000));
}

function meetingStatusLabel(status: Meeting["status"]) {
  if (status === "SCHEDULED") return "Agendada";
  if (status === "WAITING") return "Lista";
  if (status === "LIVE") return "En vivo";
  if (status === "ENDED") return "Finalizada";
  return status;
}

function filterAgendaMeetings(meetings: Meeting[], filter: AgendaFilter) {
  const today = meetingDayKey(new Date());
  const now = Date.now();
  const weekEnd = now + 7 * 24 * 60 * 60 * 1000;

  return meetings
    .filter((meeting) => {
      if (filter === "all") return true;
      if (meeting.status === "ENDED") return false;
      if (filter === "today") return meetingDayKey(meeting.startsAt) === today;
      const timestamp = meetingTimestamp(meeting);
      return timestamp >= now && timestamp <= weekEnd;
    })
    .sort((left, right) => {
      const leftEnded = left.status === "ENDED";
      const rightEnded = right.status === "ENDED";
      if (leftEnded !== rightEnded) return leftEnded ? 1 : -1;
      return meetingTimestamp(left) - meetingTimestamp(right);
    });
}

function meetingShareUrl(code: string) {
  const configuredUrl = (import.meta.env.VITE_SHAPE_MEETING_URL as string | undefined) ?? (import.meta.env.VITE_SHAPE_APP_URL as string | undefined);
  const baseUrl = configuredUrl?.replace(/\/$/, "") || "https://meet.shape.local";
  return `${baseUrl}/r/${code}`;
}

function videoCaptureOptions(deviceId: string): VideoCaptureOptions {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    resolution: { width: 1280, height: 720, frameRate: 30 }
  };
}

function audioCaptureOptions(deviceId: string): AudioCaptureOptions {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  };
}

function mediaTrackAudioConstraints(deviceId: string): MediaTrackConstraints {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  };
}

function mediaTrackVideoConstraints(deviceId: string): MediaTrackConstraints {
  return {
    width: 1280,
    height: 720,
    frameRate: 30,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {})
  };
}

async function prepareIdentityForAiSession(identity: HostIdentity | null, hostToken: string | null): Promise<{
  identity: HostIdentity | null;
  cache: NativeIdentityArtifactCacheResult | null;
}> {
  if (!identity) {
    return { identity: null, cache: null };
  }

  let resolvedIdentity = identity;

  if (hostToken) {
    try {
      const artifact = await getHostIdentityArtifact(identity.id, hostToken);
      resolvedIdentity = {
        ...identity,
        ...artifact,
        artifactUri: artifact.downloadUrl ?? artifact.artifactUri
      };
    } catch (error) {
      if (!identity.artifactUri) {
        throw error;
      }
    }
  }

  if (!resolvedIdentity.artifactUri) {
    return { identity: resolvedIdentity, cache: null };
  }

  const cache = await cacheIdentityArtifact(resolvedIdentity);
  return { identity: resolvedIdentity, cache };
}

function evictUnauthorizedIdentityArtifacts(previousIdentities: HostIdentity[], nextIdentities: HostIdentity[]) {
  const authorizedIds = new Set(nextIdentities.map((identity) => identity.id));
  const staleIdentities = previousIdentities.filter((identity) => !authorizedIds.has(identity.id));

  if (staleIdentities.length === 0) return;

  void Promise.allSettled(staleIdentities.map((identity) => evictIdentityArtifact(identity.id)));
}

export default function App() {
  const [route, setRoute] = useState<Route>(initialDeepLinkCode ? "join" : "home");
  const [isHostFlow, setIsHostFlow] = useState(false);
  const [hostSession, setHostSession] = useState<HostSession | null>(null);
  const [host, setHost] = useState<ShapeUser | null>(null);
  const [meetings, setMeetings] = useState<Meeting[]>(initialMeetings);
  const [currentMeeting, setCurrentMeeting] = useState<Meeting | null>(initialMeeting);
  const [identities, setIdentities] = useState<HostIdentity[]>(initialIdentities);
  const [selectedIdentityId, setSelectedIdentityId] = useState<string | null>(initialIdentity?.id ?? null);
  const [joinCode, setJoinCode] = useState(initialDeepLinkCode || initialMeeting?.code || "");
  const [guestName, setGuestName] = useState(initialGuestName);
  const [guestEmail, setGuestEmail] = useState(initialGuestEmail);
  const [waitingParticipantId, setWaitingParticipantId] = useState<string | null>(null);
  const [pendingDeepLinkCode, setPendingDeepLinkCode] = useState(initialDeepLinkCode);
  const [liveKitConnection, setLiveKitConnection] = useState<(LiveKitConnection & { warning?: string }) | null>(null);
  const [apiMessage, setApiMessage] = useState<string | null>(null);
  const [micEnabled, setMicEnabled] = useState(true);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [deviceSelection, setDeviceSelection] = useState<DeviceSelection>(() => readStoredDeviceSelection());
  const [faceEnabled, setFaceEnabled] = useState(false);
  const [backgroundEnabled, setBackgroundEnabled] = useState(true);
  const [backgroundCalibration, setBackgroundCalibration] = useState<BackgroundCalibration | null>(null);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [debugMessage, setDebugMessage] = useState<string | null>(null);
  const [gpuProfile, setGpuProfile] = useState<NativeGpuProfile | null>(null);
  const [aiServiceStatus, setAiServiceStatus] = useState<NativeAiServiceStatus | null>(null);
  const [aiSidecarRuntime, setAiSidecarRuntime] = useState<NativeAiSidecarRuntime | null>(null);
  const [observabilityStatus, setObservabilityStatus] = useState<NativeObservabilityStatus | null>(null);
  const mediaDevices = useMediaDevices();

  useEffect(() => {
    void getGpuProfile().then(setGpuProfile);
    void getAiServiceStatus().then(setAiServiceStatus);
    void getAiSidecarRuntime().then(setAiSidecarRuntime);
    void getObservabilityStatus().then(setObservabilityStatus);
  }, []);

  useEffect(() => {
    const normalized = normalizeDeviceSelection(deviceSelection, mediaDevices.choices);
    if (
      normalized.cameraId !== deviceSelection.cameraId ||
      normalized.microphoneId !== deviceSelection.microphoneId ||
      normalized.speakerId !== deviceSelection.speakerId
    ) {
      setDeviceSelection(normalized);
    }
  }, [deviceSelection, mediaDevices.choices]);

  useEffect(() => {
    writeStoredDeviceSelection(deviceSelection);
  }, [deviceSelection]);

  useEffect(() => {
    if (route !== "device-test") return;
    if (mediaDevices.permissionRequested) return;
    void mediaDevices.requestDeviceAccess();
  }, [mediaDevices, route]);

  useEffect(() => {
    const token = getStoredHostToken();
    if (!token) return;

    void getCurrentHost(token)
      .then((user) => {
        if (!user) return;
        const session = { token, user };
        setHostSession(session);
        setHost(user);
        void refreshHostData(session);
      })
      .catch((error) => setApiMessage(error instanceof Error ? error.message : "No se pudo restaurar la sesión."));
  }, []);

  useEffect(() => {
    if (!pendingDeepLinkCode) return;

    let cancelled = false;

    async function resolveDeepLink() {
      try {
        setApiMessage(null);
        const meeting = await findMeeting(pendingDeepLinkCode);
        if (cancelled) return;
        setCurrentMeeting(meeting);
        setJoinCode(meeting.code);
        setIsHostFlow(false);
        setRoute("found");
      } catch (error) {
        if (cancelled) return;

        const localMeeting = findInitialMeeting(pendingDeepLinkCode);
        if (localMeeting && canUseDemoRuntimeFallback(error)) {
          setCurrentMeeting(localMeeting);
          setJoinCode(localMeeting.code);
          setIsHostFlow(false);
          setRoute("found");
          return;
        }

        setRoute("join");
        setApiMessage(error instanceof Error ? error.message : "No se pudo encontrar la reunión.");
      } finally {
        if (!cancelled) setPendingDeepLinkCode("");
      }
    }

    void resolveDeepLink();

    return () => {
      cancelled = true;
    };
  }, [pendingDeepLinkCode]);

  function navigate(nextRoute: Route) {
    setApiMessage(null);
    setRoute(nextRoute);
  }

  function startHostLogin() {
    setIsHostFlow(true);
    navigate("login");
  }

  async function continueAfterDeviceTest() {
    if (isHostFlow) {
      if (!currentMeeting) {
        setApiMessage("Selecciona o crea una reunión antes de continuar.");
        navigate("scheduled");
        return;
      }

      navigate("host-settings");
      return;
    }

    await handleRequestMeetingAccess();
  }

  async function handleDebugBundle() {
    const result = await exportDebugBundle();
    setDebugMessage(result);
  }

  async function handleNativeDebugEvent() {
    const result = await captureNativeDebugEvent("Shape Meet manual native debug event");
    setDebugMessage(result.captured && result.eventId ? `Evento Sentry enviado: ${result.eventId}` : result.message);
  }

  async function refreshAiRuntime() {
    const [service, runtime] = await Promise.all([getAiServiceStatus(), getAiSidecarRuntime()]);
    setAiServiceStatus(service);
    setAiSidecarRuntime(runtime);
  }

  async function handleStartAiSidecar() {
    const runtime = await startAiSidecar();
    setAiSidecarRuntime(runtime);
    await refreshAiRuntime();
    setDebugMessage(runtime.message);
  }

  async function handleStopAiSidecar() {
    const runtime = await stopAiSidecar();
    setAiSidecarRuntime(runtime);
    await refreshAiRuntime();
    setDebugMessage(runtime.message);
  }

  function updateDeviceSelection(key: keyof DeviceSelection, value: string) {
    setDeviceSelection((current) => ({ ...current, [key]: value }));
  }

  function updateMeetingState(meeting: Meeting) {
    setCurrentMeeting(meeting);
    setMeetings((current) => current.map((item) => (item.id === meeting.id ? meeting : item)));
  }

  function mediaParticipantId() {
    return liveKitConnection?.identity ?? waitingParticipantId;
  }

  function patchLocalParticipantMedia(participantId: string, media: { camera?: boolean; microphone?: boolean }) {
    if (!currentMeeting) return;

    updateMeetingState({
      ...currentMeeting,
      participants: currentMeeting.participants.map((participant) =>
        participant.id === participantId
          ? {
              ...participant,
              ...(media.camera !== undefined ? { camera: media.camera ? "on" : "off" } : {}),
              ...(media.microphone !== undefined ? { mic: media.microphone ? "on" : "muted" } : {})
            }
          : participant
      )
    });
  }

  async function syncParticipantMedia(media: { camera?: boolean; microphone?: boolean }) {
    const participantId = mediaParticipantId();
    const meeting = currentMeeting;

    if (!participantId || !meeting) return;

    patchLocalParticipantMedia(participantId, media);

    try {
      const updatedMeeting = await updateMeetingParticipantMedia({
        code: meeting.code,
        participantId,
        camera: media.camera,
        microphone: media.microphone,
        token: isHostFlow ? hostSession?.token : null
      });
      updateMeetingState(updatedMeeting);
      setApiMessage(null);
    } catch (error) {
      setApiMessage(error instanceof Error ? error.message : "No se pudo sincronizar el estado del dispositivo.");
    }
  }

  function handleToggleCamera() {
    const nextEnabled = !cameraEnabled;
    setCameraEnabled(nextEnabled);
    void syncParticipantMedia({ camera: nextEnabled });
  }

  function handleToggleMic() {
    const nextEnabled = !micEnabled;
    setMicEnabled(nextEnabled);
    void syncParticipantMedia({ microphone: nextEnabled });
  }

  async function refreshHostData(session = hostSession) {
    if (!session) return;

    const [nextMeetings, nextIdentities] = await Promise.all([
      listHostMeetings(session.token),
      listHostIdentities(session.token)
    ]);

    setMeetings(nextMeetings);

    if (nextMeetings.length > 0) {
      setCurrentMeeting(nextMeetings[0]!);
      setJoinCode(nextMeetings[0]!.code);
    }

    evictUnauthorizedIdentityArtifacts(identities, nextIdentities);
    setIdentities(nextIdentities);
    setSelectedIdentityId((current) => (current && nextIdentities.some((identity) => identity.id === current) ? current : nextIdentities[0]?.id ?? null));
  }

  async function handleHostLogin(identifier: string, password: string) {
    try {
      setApiMessage(null);
      const session = await loginHost(identifier, password);
      setHostSession(session);
      setHost(session.user);
      setIsHostFlow(true);
      await refreshHostData(session);
      navigate("verify");
    } catch (error) {
      if (error instanceof ShapeApiError && error.code === "NOT_HOST") {
        navigate("denied");
        return;
      }

      if (canUseDemoHostFallback(error, identifier, password)) {
        const demoHost = mockUsers.find((user) => user.rank === "HOST") ?? mockUsers[0]!;
        const session = { token: "shape-demo-host-token", user: demoHost };
        setHostSession(session);
        setHost(demoHost);
        setIsHostFlow(true);
        setMeetings(initialMeetings);
        setCurrentMeeting(initialMeeting);
        setJoinCode(initialMeeting?.code ?? "");
        setIdentities(initialIdentities);
        setSelectedIdentityId(initialIdentity?.id ?? null);
        navigate("verify");
        return;
      }

      setApiMessage(error instanceof Error ? error.message : "No se pudo iniciar sesión.");
    }
  }

  async function handleFindMeeting() {
    try {
      setApiMessage(null);
      setWaitingParticipantId(null);
      if (!joinCode.trim()) {
        setApiMessage("Ingresa un código o enlace de reunión.");
        return;
      }

      const meeting = await findMeeting(joinCode);
      setCurrentMeeting(meeting);
      setJoinCode(meeting.code);
      navigate("found");
    } catch (error) {
      const localMeeting = findInitialMeeting(joinCode);
      if (localMeeting && canUseDemoRuntimeFallback(error)) {
        setCurrentMeeting(localMeeting);
        setJoinCode(localMeeting.code);
        navigate("found");
        return;
      }

      setApiMessage(error instanceof Error ? error.message : "No se pudo encontrar la reunión.");
    }
  }

  async function handleCreateMeeting(input: MeetingCreateInput) {
    try {
      setApiMessage(null);
      const meeting = await createHostMeeting(input, hostSession?.token);
      setMeetings((current) => [meeting, ...current]);
      setCurrentMeeting(meeting);
      setJoinCode(meeting.code);
      navigate("created");
    } catch (error) {
      if (canUseDemoRuntimeFallback(error)) {
        const meeting = createDemoMeeting(input, host);
        setMeetings((current) => [meeting, ...current]);
        setCurrentMeeting(meeting);
        setJoinCode(meeting.code);
        navigate("created");
        return;
      }

      setApiMessage(error instanceof Error ? error.message : "No se pudo crear la reunión.");
    }
  }

  function handleHostLogout() {
    clearHostToken();
    setHostSession(null);
    setHost(null);
    setIsHostFlow(false);
    setMeetings(initialMeetings);
    setIdentities(initialIdentities);
    setSelectedIdentityId(initialIdentity?.id ?? null);
    setCurrentMeeting(initialMeeting);
    setJoinCode(initialDeepLinkCode || initialMeeting?.code || "");
    setLiveKitConnection(null);
    setWaitingParticipantId(null);
    setApiMessage(null);
    navigate("home");
  }

  async function refreshCurrentMeeting() {
    if (!currentMeeting) {
      throw new Error("No hay reunión seleccionada.");
    }

    const meeting = await findMeeting(currentMeeting.code, isHostFlow ? hostSession?.token : null);
    setCurrentMeeting(meeting);
    return meeting;
  }

  async function handleRequestMeetingAccess() {
    try {
      setApiMessage(null);
      if (!currentMeeting) {
        setApiMessage("Busca una reunión antes de probar tu equipo.");
        navigate("join");
        return;
      }

      if (!guestName.trim()) {
        setApiMessage("Ingresa tu nombre visible.");
        navigate("join");
        return;
      }

      const result = await requestMeetingAccess({
        code: currentMeeting.code,
        displayName: guestName.trim(),
        email: guestEmail.trim() || null,
        camera: cameraEnabled,
        microphone: micEnabled
      });

      setWaitingParticipantId(result.participantId);
      setCurrentMeeting(result.meeting);
      navigate("waiting");
    } catch (error) {
      setApiMessage(error instanceof Error ? error.message : "No se pudo solicitar acceso.");
    }
  }

  async function handleEnterCall(participantId = waitingParticipantId) {
    try {
      setApiMessage(null);
      if (!currentMeeting) {
        setApiMessage("Selecciona una reunión antes de entrar.");
        navigate(isHostFlow ? "scheduled" : "join");
        return;
      }

      const displayName = isHostFlow ? host?.username ?? "Host" : guestName;

      if (!isHostFlow && !participantId) {
        await handleRequestMeetingAccess();
        return;
      }

      const result = await requestMeetingToken({
        code: currentMeeting.code,
        displayName,
        camera: cameraEnabled,
        microphone: micEnabled,
        participantId: isHostFlow ? null : participantId,
        token: isHostFlow ? hostSession?.token : null
      });

      setCurrentMeeting(result.meeting);
      setLiveKitConnection(result.livekit);
      setWaitingParticipantId(null);
      navigate("call");
    } catch (error) {
      if (canUseDemoRuntimeFallback(error) && currentMeeting) {
        const now = new Date().toISOString();
        const identity = isHostFlow
          ? currentMeeting.participants.find((participant) => participant.role === "host")?.id ?? `host_${currentMeeting.hostId}`
          : participantId ?? currentMeeting.participants.find((participant) => participant.role !== "host")?.id ?? "guest_demo";

        setCurrentMeeting({
          ...currentMeeting,
          status: "LIVE",
          participants: currentMeeting.participants.map((participant) =>
            participant.id === identity
              ? {
                  ...participant,
                  camera: cameraEnabled ? "on" : "off",
                  mic: micEnabled ? "on" : "muted",
                  admittedAt: participant.admittedAt ?? now,
                  joinedAt: participant.joinedAt ?? now,
                  leftAt: null
                }
              : participant
          )
        });
        setLiveKitConnection({
          url: null,
          token: null,
          room: currentMeeting.code,
          identity,
          warning: "Modo demo sin LiveKit local."
        });
        setWaitingParticipantId(null);
        navigate("call");
        return;
      }

      setApiMessage(error instanceof Error ? error.message : "No se pudo entrar a la reunión.");
    }
  }

  async function handleAdmitParticipant(participantId: string) {
    try {
      setApiMessage(null);
      if (!currentMeeting) {
        setApiMessage("No hay reunión activa para admitir participantes.");
        return;
      }

      const meeting = await admitMeetingParticipant({
        code: currentMeeting.code,
        participantId,
        token: hostSession?.token
      });
      setCurrentMeeting(meeting);
    } catch (error) {
      setApiMessage(error instanceof Error ? error.message : "No se pudo admitir al participante.");
    }
  }

  function handleLeaveWaitingRoom() {
    const participantId = waitingParticipantId;
    const meetingCode = currentMeeting?.code;

    setWaitingParticipantId(null);
    navigate("home");

    if (!participantId || !meetingCode) return;

    void leaveMeeting({ code: meetingCode, participantId })
      .then((meeting) => setCurrentMeeting(meeting))
      .catch((error) => setApiMessage(error instanceof Error ? error.message : "No se pudo cerrar la solicitud."));
  }

  function handleLeaveCall() {
    const participantId = liveKitConnection?.identity;
    const meetingCode = currentMeeting?.code;
    const hostToken = isHostFlow ? hostSession?.token : null;

    setLiveKitConnection(null);
    navigate("home");

    if (!meetingCode) return;

    if (isHostFlow) {
      void endMeeting({ code: meetingCode, token: hostToken })
        .then((meeting) => setCurrentMeeting(meeting))
        .catch((error) => setApiMessage(error instanceof Error ? error.message : "No se pudo finalizar la reunión."));
      return;
    }

    if (!participantId) return;

    void leaveMeeting({ code: meetingCode, participantId, token: hostToken })
      .then((meeting) => setCurrentMeeting(meeting))
      .catch((error) => setApiMessage(error instanceof Error ? error.message : "No se pudo registrar la salida."));
  }

  useEffect(() => {
    if (route !== "waiting" || !waitingParticipantId || !currentMeeting) return;

    const interval = window.setInterval(() => {
      void refreshCurrentMeeting().catch((error) => setApiMessage(error instanceof Error ? error.message : "No se pudo actualizar la sala."));
    }, 2500);

    void refreshCurrentMeeting().catch(() => undefined);

    return () => window.clearInterval(interval);
  }, [currentMeeting?.code, route, waitingParticipantId]);

  useEffect(() => {
    if (route !== "call" || !currentMeeting || liveKitConnection?.warning) return;

    const syncMeeting = async () => {
      const meeting = await refreshCurrentMeeting();
      if (meeting.status !== "ENDED") return;

      setLiveKitConnection(null);
      navigate("home");
      setApiMessage("La reunión terminó.");
    };

    const interval = window.setInterval(() => {
      void syncMeeting().catch((error) => setApiMessage(error instanceof Error ? error.message : "No se pudo actualizar la reunión."));
    }, 2500);

    return () => window.clearInterval(interval);
  }, [currentMeeting?.code, liveKitConnection?.warning, route]);

  const waitingParticipant = waitingParticipantId && currentMeeting
    ? currentMeeting.participants.find((participant) => participant.id === waitingParticipantId)
    : null;
  const waitingAdmitted = Boolean(waitingParticipant?.admittedAt);
  const selectedIdentity = identities.find((identity) => identity.id === selectedIdentityId) ?? identities[0] ?? null;

  return (
    <main className="app-shell">
      {route === "home" && <HomeScreen onJoin={() => navigate("join")} onHost={startHostLogin} />}
      {route === "join" && (
        <JoinScreen
          code={joinCode}
          name={guestName}
          email={guestEmail}
          error={apiMessage}
          onBack={() => navigate("home")}
          onCodeChange={setJoinCode}
          onNameChange={setGuestName}
          onEmailChange={setGuestEmail}
          onContinue={() => void handleFindMeeting()}
        />
      )}
      {route === "found" && (
        currentMeeting ? (
          <MeetingFoundScreen
            meeting={currentMeeting}
            onBack={() => navigate("join")}
            onContinue={() => {
              setIsHostFlow(false);
              navigate("device-test");
            }}
          />
        ) : (
          <MissingMeetingScreen onBack={() => navigate("join")} />
        )
      )}
      {route === "login" && (
        <HostLoginScreen
          error={apiMessage}
          onBack={() => navigate("home")}
          onContinue={handleHostLogin}
        />
      )}
      {route === "verify" && (
        <HostVerifyScreen
          hostEmail={host?.email ?? hostSession?.user.email ?? initialHostIdentifier}
          onBack={() => navigate("login")}
          onContinue={() => navigate("scheduled")}
        />
      )}
      {route === "denied" && <HostDeniedScreen onPublicJoin={() => navigate("join")} onSwitchAccount={() => navigate("home")} />}
      {route === "scheduled" && (
        <ScheduledMeetingsScreen
          meetings={meetings}
          onBack={() => navigate("home")}
          onCreate={() => navigate("create")}
          onOpen={(meeting) => {
            setCurrentMeeting(meeting);
            setJoinCode(meeting.code);
            navigate("meeting-detail");
          }}
        />
      )}
      {route === "meeting-detail" && (
        currentMeeting ? (
          <MeetingDetailScreen
            meeting={currentMeeting}
            onBack={() => navigate("scheduled")}
            onContinue={() => {
              setIsHostFlow(true);
              navigate("device-test");
            }}
          />
        ) : (
          <MissingMeetingScreen onBack={() => navigate("scheduled")} />
        )
      )}
      {route === "create" && <CreateMeetingScreen error={apiMessage} onBack={() => navigate("scheduled")} onCreate={handleCreateMeeting} />}
      {route === "created" && (
        currentMeeting ? (
          <MeetingCreatedScreen
            shareUrl={meetingShareUrl(currentMeeting.code)}
            onCopy={() => void navigator.clipboard?.writeText(meetingShareUrl(currentMeeting.code))}
            onContinue={() => navigate("device-test")}
          />
        ) : (
          <MissingMeetingScreen onBack={() => navigate("scheduled")} />
        )
      )}
      {route === "device-test" && (
        <DeviceTestScreen
          cameraEnabled={cameraEnabled}
          micEnabled={micEnabled}
          deviceSelection={deviceSelection}
          deviceChoices={mediaDevices.choices}
          deviceError={mediaDevices.error}
          devicesRefreshing={mediaDevices.refreshing}
          gpuProfile={gpuProfile}
          aiServiceStatus={aiServiceStatus}
          aiSidecarRuntime={aiSidecarRuntime}
          observabilityStatus={observabilityStatus}
          onBack={() => navigate(isHostFlow ? "scheduled" : "found")}
          onContinue={continueAfterDeviceTest}
          onDeviceChange={updateDeviceSelection}
          onRefreshDevices={mediaDevices.requestDeviceAccess}
          onToggleCamera={handleToggleCamera}
          onToggleMic={handleToggleMic}
          onDebug={handleDebugBundle}
          onDebugEvent={handleNativeDebugEvent}
          onStartAi={handleStartAiSidecar}
          onStopAi={handleStopAiSidecar}
          debugMessage={debugMessage}
        />
      )}
      {route === "host-settings" && (
        <HostSettingsScreen
          cameraEnabled={cameraEnabled}
          faceEnabled={faceEnabled}
          backgroundEnabled={backgroundEnabled}
          voiceEnabled={voiceEnabled}
          deviceSelection={deviceSelection}
          deviceChoices={mediaDevices.choices}
          host={host}
          identities={identities}
          backgroundCalibration={backgroundCalibration}
          selectedIdentityId={selectedIdentity?.id ?? null}
          onIdentityChange={setSelectedIdentityId}
          onDeviceChange={updateDeviceSelection}
          onToggleFace={() => setFaceEnabled((value) => !value)}
          onToggleBackground={() => setBackgroundEnabled((value) => !value)}
          onToggleVoice={() => setVoiceEnabled((value) => !value)}
          onOpenBackgroundCalibration={() => navigate("background-calibration")}
          onBack={() => navigate("device-test")}
          onSkip={() => void handleEnterCall()}
          onContinue={() => void handleEnterCall()}
        />
      )}
      {route === "background-calibration" && (
        <BackgroundCalibrationScreen
          cameraEnabled={cameraEnabled}
          cameraDeviceId={deviceSelection.cameraId}
          calibration={backgroundCalibration}
          onBack={() => navigate("host-settings")}
          onCapture={setBackgroundCalibration}
          onContinue={() => navigate("host-settings")}
        />
      )}
      {route === "waiting" && (
        currentMeeting ? (
          <WaitingRoomScreen
            meeting={currentMeeting}
            cameraEnabled={cameraEnabled}
            micEnabled={micEnabled}
            cameraDeviceId={deviceSelection.cameraId}
            onToggleCamera={handleToggleCamera}
            onToggleMic={handleToggleMic}
            onSettings={() => navigate("device-test")}
            onLeave={handleLeaveWaitingRoom}
            admitted={waitingAdmitted}
            onEnter={() => void handleEnterCall(waitingParticipantId)}
            error={apiMessage}
          />
        ) : (
          <MissingMeetingScreen onBack={() => navigate("join")} />
        )
      )}
      {route === "call" && (
        currentMeeting ? (
          <ActiveCallScreen
            meeting={currentMeeting}
            liveKitConnection={liveKitConnection}
            hostMode={isHostFlow}
            hostToken={hostSession?.token ?? getStoredHostToken()}
            identity={selectedIdentity}
            deviceSelection={deviceSelection}
            cameraEnabled={cameraEnabled}
            micEnabled={micEnabled}
            faceEnabled={faceEnabled}
            backgroundEnabled={backgroundEnabled}
            backgroundCalibration={backgroundCalibration}
            voiceEnabled={voiceEnabled}
            mediaSyncError={apiMessage}
            onToggleCamera={handleToggleCamera}
            onToggleMic={handleToggleMic}
            onAdmitParticipant={(participantId) => void handleAdmitParticipant(participantId)}
            onLeave={handleLeaveCall}
          />
        ) : (
          <MissingMeetingScreen onBack={() => navigate("home")} />
        )
      )}
    </main>
  );
}

function HomeScreen({ onJoin, onHost }: { onJoin: () => void; onHost: () => void }) {
  return (
    <section className="screen minimal-screen">
      <div className="home-top">
        <Brand />
      </div>
      <div className="home-entry">
        <LogoMark size="large" />
        <div className="home-copy">
          <h1>Reuniones listas para entrar</h1>
        </div>
        <div className="home-actions">
          <Button icon={<LogIn />} onClick={onJoin}>
            Unirse a una reunión
          </Button>
          <Button variant="outline" icon={<Lock />} onClick={onHost}>
            Iniciar sesión como host
          </Button>
        </div>
      </div>
    </section>
  );
}

function JoinScreen({
  code,
  name,
  email,
  error,
  onBack,
  onCodeChange,
  onNameChange,
  onEmailChange,
  onContinue
}: {
  code: string;
  name: string;
  email: string;
  error: string | null;
  onBack: () => void;
  onCodeChange: (value: string) => void;
  onNameChange: (value: string) => void;
  onEmailChange: (value: string) => void;
  onContinue: () => void;
}) {
  return (
    <ScreenFrame title="Unirse a reunión" onBack={onBack}>
      <CenteredPanel width={540}>
        <h1>Pega el enlace o código</h1>
        <TextField label="Enlace o código de reunión" icon={<LogIn />} value={code} onChange={onCodeChange} />
        <TextField label="Nombre visible" icon={<UserRound />} value={name} onChange={onNameChange} />
        <TextField label="Correo" icon={<Mail />} value={email} onChange={onEmailChange} type="email" autoComplete="email" />
        <Checkbox label="Recordar nombre" checked />
        <Button icon={<ArrowRight />} onClick={onContinue}>
          Continuar
        </Button>
        {error ? <InlineNotice icon={<ShieldAlert />}>{error}</InlineNotice> : null}
      </CenteredPanel>
    </ScreenFrame>
  );
}

function MeetingFoundScreen({
  meeting,
  onBack,
  onContinue
}: {
  meeting: Meeting;
  onBack: () => void;
  onContinue: () => void;
}) {
  return (
    <ScreenFrame title="Unirse a reunión" onBack={onBack}>
      <CenteredPanel width={620}>
        <StatusIcon icon={<Calendar />} />
        <h1>{meeting.title}</h1>
        <p>{formatMeetingTime(meeting.startsAt)} · Hasta {meeting.maxParticipants} participantes</p>
        <div className="detail-list">
          <DetailRow label="Organizador" value={meetingHostName(meeting)} />
          <DetailRow label="Acceso" value="Sala de espera" />
          <DetailRow label="Código" value={meeting.code} />
        </div>
        <Button icon={<ArrowRight />} onClick={onContinue}>
          Probar equipo
        </Button>
      </CenteredPanel>
    </ScreenFrame>
  );
}

function MissingMeetingScreen({ onBack }: { onBack: () => void }) {
  return (
    <ScreenFrame title="Reunión" onBack={onBack}>
      <CenteredPanel width={540}>
        <StatusIcon tone="warning" icon={<ShieldAlert />} />
        <h1>Reunión no seleccionada</h1>
        <Button icon={<ArrowLeft />} onClick={onBack}>
          Volver
        </Button>
      </CenteredPanel>
    </ScreenFrame>
  );
}

function HostLoginScreen({
  error,
  onBack,
  onContinue
}: {
  error: string | null;
  onBack: () => void;
  onContinue: (identifier: string, password: string) => Promise<void>;
}) {
  const [identifier, setIdentifier] = useState(initialHostIdentifier);
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setSubmitting(true);

    try {
      await onContinue(identifier, password);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="screen minimal-screen">
      <div className="auth-top">
        <Brand />
        <Button variant="outline" icon={<LogIn />} onClick={onBack}>
          Entrar a reunión
        </Button>
      </div>
      <AuthCard>
        <form
          className="auth-card-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <StatusIcon icon={<Lock />} />
          <h1>Inicia sesión como host</h1>
          <TextField label="Correo o usuario" icon={<Mail />} value={identifier} onChange={setIdentifier} autoComplete="username" />
          <TextField label="Contraseña" icon={<KeyRound />} value={password} onChange={setPassword} type="password" autoComplete="current-password" />
          <Button icon={<ArrowRight />} disabled={submitting || password.length < 8} type="submit">
            {submitting ? "Validando" : "Continuar"}
          </Button>
          {error ? <InlineNotice icon={<ShieldAlert />}>{error}</InlineNotice> : null}
        </form>
      </AuthCard>
    </section>
  );
}

function HostVerifyScreen({ hostEmail, onBack, onContinue }: { hostEmail: string; onBack: () => void; onContinue: () => void }) {
  const [digits, setDigits] = useState<string[]>(() => (DEMO_DATA_ENABLED ? ["1", "2", "3", "", "", ""] : ["", "", "", "", "", ""]));
  const [resendMessage, setResendMessage] = useState<string | null>(null);
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const verificationCode = digits.join("");
  const canVerify = verificationCode.length === 6;

  function focusDigit(index: number) {
    inputRefs.current[index]?.focus();
  }

  function updateDigits(nextDigits: string[], focusIndex?: number) {
    setDigits(nextDigits);
    setResendMessage(null);
    if (focusIndex !== undefined) {
      window.setTimeout(() => focusDigit(focusIndex), 0);
    }
  }

  function handleDigitChange(index: number, value: string) {
    const numeric = value.replace(/\D/g, "");
    if (numeric.length > 1) {
      const nextDigits = [...digits];
      numeric.slice(0, 6 - index).split("").forEach((digit, offset) => {
        nextDigits[index + offset] = digit;
      });
      updateDigits(nextDigits, Math.min(index + numeric.length, 5));
      return;
    }

    const nextDigits = [...digits];
    nextDigits[index] = numeric;
    updateDigits(nextDigits, numeric && index < 5 ? index + 1 : undefined);
  }

  function handleDigitKeyDown(index: number, key: string) {
    if (key === "Backspace" && !digits[index] && index > 0) {
      updateDigits(digits.map((digit, digitIndex) => (digitIndex === index - 1 ? "" : digit)), index - 1);
    }
  }

  function handlePaste(index: number, value: string) {
    const numeric = value.replace(/\D/g, "");
    if (!numeric) return;

    const nextDigits = [...digits];
    numeric.slice(0, 6 - index).split("").forEach((digit, offset) => {
      nextDigits[index + offset] = digit;
    });
    updateDigits(nextDigits, Math.min(index + numeric.length, 5));
  }

  function resendCode() {
    setDigits(DEMO_DATA_ENABLED ? ["1", "2", "3", "", "", ""] : ["", "", "", "", "", ""]);
    setResendMessage("Código reenviado.");
    window.setTimeout(() => focusDigit(DEMO_DATA_ENABLED ? 3 : 0), 0);
  }

  return (
    <section className="screen minimal-screen">
      <div className="auth-top">
        <Brand />
        <Button variant="outline" icon={<LogIn />} onClick={onBack}>
          Entrar a reunión
        </Button>
      </div>
      <AuthCard height={560}>
        <StatusIcon icon={<ShieldCheck />} />
        <h1>Confirma que eres host</h1>
        <p>Código enviado a {hostEmail}.</p>
        <div className="otp-row">
          {digits.map((digit, index) => (
            <input
              aria-label={`Dígito ${index + 1}`}
              autoComplete={index === 0 ? "one-time-code" : "off"}
              className="otp-cell"
              inputMode="numeric"
              key={index}
              maxLength={1}
              onChange={(event) => handleDigitChange(index, event.target.value)}
              onKeyDown={(event) => handleDigitKeyDown(index, event.key)}
              onPaste={(event) => {
                event.preventDefault();
                handlePaste(index, event.clipboardData.getData("text"));
              }}
              ref={(element) => {
                inputRefs.current[index] = element;
              }}
              value={digit}
            />
          ))}
        </div>
        <Checkbox label="Recordar este equipo" checked />
        <Button icon={<Check />} onClick={onContinue} disabled={!canVerify}>
          Verificar y continuar
        </Button>
        <Button variant="outline" icon={<RefreshCw />} onClick={resendCode}>
          Reenviar código
        </Button>
        {resendMessage ? <p className="resend-message">{resendMessage}</p> : null}
      </AuthCard>
    </section>
  );
}

function HostDeniedScreen({ onPublicJoin, onSwitchAccount }: { onPublicJoin: () => void; onSwitchAccount: () => void }) {
  return (
    <section className="screen minimal-screen">
      <div className="auth-top">
        <Brand />
        <Button variant="outline" icon={<LogIn />} onClick={onPublicJoin}>
          Entrar a reunión
        </Button>
      </div>
      <AuthCard height={420}>
        <StatusIcon tone="warning" icon={<ShieldAlert />} />
        <h1>Este usuario no puede ser host</h1>
        <Button icon={<UserRound />} onClick={onSwitchAccount}>
          Cambiar cuenta
        </Button>
        <Button variant="outline" icon={<LogIn />} onClick={onPublicJoin}>
          Entrar a una reunión
        </Button>
      </AuthCard>
    </section>
  );
}

function ScheduledMeetingsScreen({
  meetings,
  onBack,
  onCreate,
  onOpen
}: {
  meetings: Meeting[];
  onBack: () => void;
  onCreate: () => void;
  onOpen: (meeting: Meeting) => void;
}) {
  const [filter, setFilter] = useState<AgendaFilter>("today");
  const visibleMeetings = useMemo(() => filterAgendaMeetings(meetings, filter), [filter, meetings]);
  const activeFilter = agendaFilters.find((item) => item.id === filter) ?? agendaFilters[0]!;

  return (
    <ScreenFrame title="Reuniones agendadas" onBack={onBack}>
      <div className="content-stack">
        <div className="section-header">
          <div>
            <h1>Reuniones agendadas</h1>
          </div>
          <div className="segmented">
            {agendaFilters.map((item) => (
              <button className={item.id === filter ? "active" : ""} key={item.id} onClick={() => setFilter(item.id)}>
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <div className="split-grid">
          <div className="meeting-list">
            {visibleMeetings.map((meeting, index) => (
              <button className="meeting-row" key={meeting.id} onClick={() => onOpen(meeting)}>
                <span className="row-icon">
                  <Video />
                </span>
                <span className="row-main">
                  <strong>{meeting.title}</strong>
                  <small>{formatMeetingTime(meeting.startsAt)} · {meeting.code}</small>
                </span>
                <span className={`status-chip ${meeting.status.toLowerCase()}`}>{meetingStatusLabel(meeting.status)}</span>
                <span className={index === 0 && meeting.status !== "ENDED" ? "row-action primary" : "row-action"}>
                  {index === 0 && meeting.status !== "ENDED" ? "Entrar" : "Ver"}
                </span>
              </button>
            ))}
            {visibleMeetings.length === 0 ? <div className="empty-state">No hay reuniones en este filtro.</div> : null}
          </div>
          <aside className="agenda-summary">
            <section className="side-panel agenda-count">
              <h2>{activeFilter.label}</h2>
              <strong className="big-number">{visibleMeetings.length} {visibleMeetings.length === 1 ? "reunión" : "reuniones"}</strong>
            </section>
            <Button icon={<Calendar />} onClick={onCreate}>
              Crear reunión
            </Button>
          </aside>
        </div>
      </div>
    </ScreenFrame>
  );
}

function MeetingDetailScreen({
  meeting,
  onBack,
  onContinue
}: {
  meeting: Meeting;
  onBack: () => void;
  onContinue: () => void;
}) {
  const meetingEnded = meeting.status === "ENDED";

  return (
    <ScreenFrame title="Detalle de reunión" onBack={onBack}>
      <div className="split-grid detail-layout">
        <section className="white-panel">
          <h1>{meeting.title}</h1>
          <div className="detail-list">
            <DetailRow label="Organizador" value={meetingHostName(meeting)} />
            <DetailRow label="Invitados" value={meetingGuestNames(meeting)} />
            <DetailRow label="Acceso" value={meeting.access === "INVITE_ONLY" ? "Solo invitados" : "Enlace público"} />
            <DetailRow label="Capacidad" value={`Hasta ${meeting.maxParticipants} participantes`} />
          </div>
          <div className="button-row">
            <Button icon={<ArrowRight />} onClick={onContinue} disabled={meetingEnded}>
              Probar equipo
            </Button>
            <Button variant="outline" icon={<Copy />} onClick={() => void navigator.clipboard?.writeText(meetingShareUrl(meeting.code))}>
              Copiar enlace
            </Button>
          </div>
        </section>
        <aside className="side-panel">
          <h2>Participantes</h2>
          {meeting.participants.map((participant) => (
            <ParticipantLine key={participant.id} name={participant.displayName} meta={participant.role === "host" ? "Host" : "Invitada"} />
          ))}
        </aside>
      </div>
    </ScreenFrame>
  );
}

function CreateMeetingScreen({
  error,
  onBack,
  onCreate
}: {
  error: string | null;
  onBack: () => void;
  onCreate: (input: MeetingCreateInput) => Promise<void>;
}) {
  const [title, setTitle] = useState(DEMO_DATA_ENABLED ? "Revisión con Luxora" : "");
  const [startsAt] = useState(defaultMeetingStartInput);
  const [access, setAccess] = useState<MeetingCreateInput["access"]>("INVITE_ONLY");
  const [invitedEmails, setInvitedEmails] = useState(DEMO_DATA_ENABLED ? "maria@luxora.co" : "");
  const [waitingRoomEnabled, setWaitingRoomEnabled] = useState(true);
  const [chatEnabled, setChatEnabled] = useState(true);
  const [internalRecordingEnabled, setInternalRecordingEnabled] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setSubmitting(true);

    try {
      await onCreate({
        title,
        startsAt: bogotaDateTimeInputToIso(startsAt),
        access,
        maxParticipants: 4,
        invitedEmails:
          access === "INVITE_ONLY"
            ? invitedEmails
                .split(",")
                .map((email) => email.trim())
                .filter(Boolean)
            : []
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ScreenFrame title="Crear reunión" onBack={onBack}>
      <div className="center-region create-meeting-region">
        <section className="white-panel centered create-meeting-panel" style={{ width: 620 }}>
          <h1>Configura lo básico</h1>
          <TextField label="Nombre de la reunión" icon={<Calendar />} value={title} onChange={setTitle} />
          <SelectField
            label="Acceso"
            value={access}
            onChange={(value) => setAccess(value as MeetingCreateInput["access"])}
            options={[
              { value: "INVITE_ONLY", label: "Solo invitados" },
              { value: "PUBLIC_LINK", label: "Enlace público" }
            ]}
          />
          <TextField label="Invitados" icon={<Users />} value={invitedEmails} onChange={setInvitedEmails} />
          <div className="create-options">
            <ToggleRow label="Sala de espera" checked={waitingRoomEnabled} onClick={() => setWaitingRoomEnabled((current) => !current)} />
            <ToggleRow label="Permitir chat" checked={chatEnabled} onClick={() => setChatEnabled((current) => !current)} />
            <ToggleRow label="Grabar en modo interno" checked={internalRecordingEnabled} onClick={() => setInternalRecordingEnabled((current) => !current)} />
          </div>
          {error ? <InlineNotice icon={<ShieldAlert />}>{error}</InlineNotice> : null}
          <div className="form-actions">
            <Button icon={<Check />} onClick={() => void submit()} disabled={submitting || title.length < 3}>
              {submitting ? "Creando" : "Crear reunión"}
            </Button>
          </div>
        </section>
      </div>
    </ScreenFrame>
  );
}

function MeetingCreatedScreen({
  shareUrl,
  onCopy,
  onContinue
}: {
  shareUrl: string;
  onCopy: () => void;
  onContinue: () => void;
}) {
  return (
    <ScreenFrame title="Crear reunión">
      <CenteredPanel width={620}>
        <StatusIcon tone="success" icon={<Check />} />
        <h1>Reunión creada</h1>
        <button className="copy-box" onClick={onCopy}>
          <span>{shareUrl}</span>
          <Copy />
        </button>
        <div className="button-row">
          <Button variant="outline" icon={<Copy />} onClick={onCopy}>
            Copiar enlace
          </Button>
          <Button icon={<ArrowRight />} onClick={onContinue}>
            Probar equipo
          </Button>
        </div>
      </CenteredPanel>
    </ScreenFrame>
  );
}

function DeviceTestScreen({
  cameraEnabled,
  micEnabled,
  deviceSelection,
  deviceChoices,
  deviceError,
  devicesRefreshing,
  gpuProfile,
  aiServiceStatus,
  aiSidecarRuntime,
  observabilityStatus,
  onBack,
  onContinue,
  onDeviceChange,
  onRefreshDevices,
  onToggleCamera,
  onToggleMic,
  onDebug,
  onDebugEvent,
  onStartAi,
  onStopAi,
  debugMessage
}: {
  cameraEnabled: boolean;
  micEnabled: boolean;
  deviceSelection: DeviceSelection;
  deviceChoices: DeviceChoices;
  deviceError: string | null;
  devicesRefreshing: boolean;
  gpuProfile: NativeGpuProfile | null;
  aiServiceStatus: NativeAiServiceStatus | null;
  aiSidecarRuntime: NativeAiSidecarRuntime | null;
  observabilityStatus: NativeObservabilityStatus | null;
  onBack: () => void;
  onContinue: () => void;
  onDeviceChange: (key: keyof DeviceSelection, value: string) => void;
  onRefreshDevices: () => void;
  onToggleCamera: () => void;
  onToggleMic: () => void;
  onDebug: () => void;
  onDebugEvent: () => void;
  onStartAi: () => void;
  onStopAi: () => void;
  debugMessage: string | null;
}) {
  const aiLabel = aiServiceStatus?.online
    ? `${aiServiceStatus.status} · ${aiServiceStatus.mode}`
    : aiServiceStatus?.message ?? "Detectando";
  const sentryLabel = observabilityStatus?.nativeSentryEnabled
    ? `Nativo activo · ${observabilityStatus.environment}`
    : observabilityStatus?.frontendSentryEnabled
      ? `Frontend activo · ${observabilityStatus.environment}`
      : "Debug local";
  const sidecarLabel = aiSidecarRuntime?.running
    ? aiSidecarRuntime.managed && aiSidecarRuntime.pid
      ? `Gestionado · ${aiSidecarRuntime.pid}`
      : "Externo"
    : aiSidecarRuntime?.message ?? "Sin iniciar";
  const gpuDevice = gpuDeviceLabel(gpuProfile);
  const gpuVram = gpuVramLabel(gpuProfile);
  const gpuCuda = gpuCudaLabel(gpuProfile);
  const gpuWarning = gpuProfile?.warnings[0] ?? null;

  return (
    <ScreenFrame title="Prueba de equipo" right={<StepDots active={1} />} onBack={onBack}>
      <div className="workbench">
        <section className="preview-column">
          <div className="section-header compact">
            <div>
              <h1>Prueba cámara y micrófono</h1>
            </div>
          </div>
          <VideoPreview enabled={cameraEnabled} label="Vista previa" cameraDeviceId={deviceSelection.cameraId} />
          <div className="control-row">
            <ControlButton active={micEnabled} icon={micEnabled ? <Mic /> : <MicOff />} label="Mic" onClick={onToggleMic} />
            <ControlButton active={cameraEnabled} icon={cameraEnabled ? <Video /> : <VideoOff />} label="Cámara" onClick={onToggleCamera} />
            <ControlButton icon={<RefreshCw />} label={devicesRefreshing ? "Buscando" : "Ajustes"} onClick={onRefreshDevices} />
          </div>
        </section>
        <aside className="settings-column">
          <Panel title="Dispositivos">
            <SelectField
              label="Cámara"
              value={deviceSelection.cameraId}
              onChange={(value) => onDeviceChange("cameraId", value)}
              options={deviceOptions(deviceChoices.videoinput, "Sin cámara")}
              disabled={deviceChoices.videoinput.length === 0}
            />
            <SelectField
              label="Micrófono"
              value={deviceSelection.microphoneId}
              onChange={(value) => onDeviceChange("microphoneId", value)}
              options={deviceOptions(deviceChoices.audioinput, "Sin micrófono")}
              disabled={deviceChoices.audioinput.length === 0}
            />
            <SelectField
              label="Salida"
              value={deviceSelection.speakerId}
              onChange={(value) => onDeviceChange("speakerId", value)}
              options={deviceOptions(deviceChoices.audiooutput, "Salida por defecto")}
              disabled={deviceChoices.audiooutput.length === 0}
            />
            {deviceError ? <InlineNotice icon={<ShieldAlert />}>{deviceError}</InlineNotice> : null}
          </Panel>
          <Panel title="IA local">
            <StatusRow label="GPU" value={gpuProfileLabel(gpuProfile)} tone={gpuTone(gpuProfile)} />
            <StatusRow label="IA local" value={aiLabel} tone={aiServiceStatus?.online ? "ok" : "warning"} />
            <StatusRow label="Sidecar" value={sidecarLabel} tone={aiSidecarRuntime?.running ? "ok" : "warning"} />
            <details className="debug-details">
              <summary>Diagnóstico</summary>
              <div className="debug-details-body">
                {gpuDevice ? <StatusRow label="Dispositivo" value={gpuDevice} tone={gpuTone(gpuProfile)} /> : null}
                {gpuVram ? <StatusRow label="VRAM" value={gpuVram} tone={gpuProfile?.gpuTier === "ready" ? "ok" : "warning"} /> : null}
                {gpuCuda ? <StatusRow label="CUDA" value={gpuCuda} tone={gpuProfile?.cudaAvailable ? "ok" : "warning"} /> : null}
                <StatusRow label="Sentry" value={sentryLabel} tone={observabilityStatus?.nativeSentryEnabled ? "ok" : "idle"} />
                {gpuWarning ? <StatusRow label="Detalle" value={gpuWarning} tone="warning" /> : null}
                <div className="stacked-actions compact">
                  <Button variant="outline" icon={<RefreshCw />} onClick={onStartAi} disabled={Boolean(aiSidecarRuntime?.running)}>
                    Iniciar IA
                  </Button>
                  <Button variant="outline" icon={<PhoneOff />} onClick={onStopAi} disabled={!aiSidecarRuntime?.managed}>
                    Detener IA
                  </Button>
                  <Button variant="outline" icon={<MonitorUp />} onClick={onDebug}>
                    Exportar debug
                  </Button>
                  <Button variant="outline" icon={<ShieldCheck />} onClick={onDebugEvent}>
                    Probar Sentry
                  </Button>
                </div>
              </div>
            </details>
          </Panel>
          {debugMessage && <InlineNotice icon={<MonitorUp />}>{debugMessage}</InlineNotice>}
          <div className="stacked-actions">
            <Button icon={<ArrowRight />} onClick={onContinue}>
              Continuar
            </Button>
          </div>
        </aside>
      </div>
    </ScreenFrame>
  );
}

function HostSettingsScreen({
  cameraEnabled,
  faceEnabled,
  backgroundEnabled,
  voiceEnabled,
  deviceSelection,
  deviceChoices,
  host,
  identities,
  backgroundCalibration,
  selectedIdentityId,
  onIdentityChange,
  onDeviceChange,
  onToggleFace,
  onToggleBackground,
  onToggleVoice,
  onOpenBackgroundCalibration,
  onBack,
  onSkip,
  onContinue
}: {
  cameraEnabled: boolean;
  faceEnabled: boolean;
  backgroundEnabled: boolean;
  voiceEnabled: boolean;
  deviceSelection: DeviceSelection;
  deviceChoices: DeviceChoices;
  host: ShapeUser | null;
  identities: HostIdentity[];
  backgroundCalibration: BackgroundCalibration | null;
  selectedIdentityId: string | null;
  onIdentityChange: (identityId: string | null) => void;
  onDeviceChange: (key: keyof DeviceSelection, value: string) => void;
  onToggleFace: () => void;
  onToggleBackground: () => void;
  onToggleVoice: () => void;
  onOpenBackgroundCalibration: () => void;
  onBack: () => void;
  onSkip: () => void;
  onContinue: () => void;
}) {
  const pushedIdentities = identities.filter((identity) => identity.status === "AVAILABLE" && identity.deliveryStatus === "PUSHED");
  const identityOptions = pushedIdentities.length > 0 ? pushedIdentities : identities;
  const hostIdentity = identityOptions.find((identity) => identity.id === selectedIdentityId) ?? identityOptions[0] ?? null;

  return (
    <ScreenFrame title="Ajustes del host" right={<Button variant="outline" icon={<LogIn />} onClick={onSkip}>Omitir y entrar</Button>} onBack={onBack}>
      <div className="workbench">
        <section className="preview-column">
          <div className="section-header compact">
            <h1>Ajustes de cámara e identidad</h1>
          </div>
          <VideoPreview enabled={cameraEnabled} label="Vista del host" cameraDeviceId={deviceSelection.cameraId} darkFooter footerText={hostIdentity?.name ?? host?.username ?? "Host"} />
        </section>
        <aside className="settings-column">
          <Panel title="Cámara">
            <SelectField
              label="Dispositivo"
              value={deviceSelection.cameraId}
              onChange={(value) => onDeviceChange("cameraId", value)}
              options={deviceOptions(deviceChoices.videoinput, "Sin cámara")}
              disabled={deviceChoices.videoinput.length === 0}
            />
            <ToggleRow label="Mejorar iluminación" checked />
          </Panel>
          <Panel title="Fondo">
            <StatusRow
              label="Clean plate"
              value={backgroundCalibration ? `${backgroundCalibration.width}x${backgroundCalibration.height}` : "Pendiente"}
              tone={backgroundCalibration ? "ok" : "warning"}
            />
            <StatusRow label="Captura" value={backgroundCalibration ? formatCaptureTime(backgroundCalibration.capturedAt) : "Sin captura"} tone={backgroundCalibration ? "ok" : "idle"} />
            <Button variant="outline" icon={<Camera />} onClick={onOpenBackgroundCalibration}>
              Calibrar fondo
            </Button>
          </Panel>
          <Panel title="Rostro aprobado">
            <SelectField
              label="Identidad"
              value={hostIdentity?.id ?? ""}
              onChange={(value) => onIdentityChange(value || null)}
              options={
                identityOptions.length > 0
                  ? identityOptions.map((identity) => ({
                      value: identity.id,
                      label: `${identity.name} · ${identity.version}`
                    }))
                  : [{ value: "", label: "Sin identidad" }]
              }
            />
            <ToggleRow label="Activar rostro aprobado" checked={faceEnabled} onClick={onToggleFace} />
            <ToggleRow label="Activar fondo personalizado" checked={backgroundEnabled} onClick={onToggleBackground} />
            <ToggleRow label="Activar voz configurada" checked={voiceEnabled} onClick={onToggleVoice} />
          </Panel>
          <div className="stacked-actions">
            <Button icon={<LogIn />} onClick={onContinue}>
              Entrar a la reunión
            </Button>
            <Button variant="outline" icon={<ArrowLeft />} onClick={onBack}>
              Volver a prueba de equipo
            </Button>
          </div>
        </aside>
      </div>
    </ScreenFrame>
  );
}

function BackgroundCalibrationScreen({
  cameraEnabled,
  cameraDeviceId,
  calibration,
  onBack,
  onCapture,
  onContinue
}: {
  cameraEnabled: boolean;
  cameraDeviceId: string;
  calibration: BackgroundCalibration | null;
  onBack: () => void;
  onCapture: (calibration: BackgroundCalibration) => void;
  onContinue: () => void;
}) {
  const { videoRef, active, error } = useCameraPreview({ enabled: cameraEnabled, deviceId: cameraDeviceId });
  const [captureError, setCaptureError] = useState<string | null>(null);

  function captureCleanPlate() {
    const video = videoRef.current;

    if (!video || !active) {
      setCaptureError("La cámara no está lista.");
      return;
    }

    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");

    if (!context) {
      setCaptureError("No se pudo capturar el fondo.");
      return;
    }

    context.drawImage(video, 0, 0, width, height);
    onCapture({
      cleanPlateDataUrl: canvas.toDataURL("image/jpeg", 0.88),
      capturedAt: new Date().toISOString(),
      width,
      height,
      cameraDeviceId
    });
    setCaptureError(null);
  }

  return (
    <ScreenFrame title="Calibrar fondo" right={<StepDots active={2} />} onBack={onBack}>
      <div className="workbench">
        <section className="preview-column">
          <div className="section-header compact">
            <h1>Captura fondo limpio</h1>
          </div>
          <div className="video-preview">
            {cameraEnabled && active ? <video ref={videoRef} muted playsInline /> : null}
            {!active ? (
              <div className="avatar-preview">
                <Camera />
              </div>
            ) : null}
            <span className="video-badge">
              <Camera />
              Fondo
            </span>
            {error ? <span className="video-error">{error}</span> : null}
          </div>
        </section>
        <aside className="settings-column">
          <Panel title="Calibración">
            <StatusRow label="Cámara" value={active ? "Lista" : "Sin señal"} tone={active ? "ok" : "warning"} />
            <StatusRow label="Clean plate" value={calibration ? "Capturado" : "Pendiente"} tone={calibration ? "ok" : "warning"} />
            <StatusRow label="Resolución" value={calibration ? `${calibration.width}x${calibration.height}` : "720p objetivo"} tone={calibration ? "ok" : "idle"} />
            {calibration ? <img className="clean-plate-thumb" src={calibration.cleanPlateDataUrl} alt="Fondo capturado" /> : null}
            {captureError ? <InlineNotice icon={<ShieldAlert />}>{captureError}</InlineNotice> : null}
          </Panel>
          <div className="stacked-actions">
            <Button icon={<Camera />} onClick={captureCleanPlate} disabled={!active}>
              Capturar fondo
            </Button>
            <Button variant="outline" icon={<ArrowLeft />} onClick={onBack}>
              Volver
            </Button>
            <Button variant="outline" icon={<ArrowRight />} onClick={onContinue} disabled={!calibration}>
              Continuar
            </Button>
          </div>
        </aside>
      </div>
    </ScreenFrame>
  );
}

function WaitingRoomScreen({
  meeting,
  cameraEnabled,
  micEnabled,
  cameraDeviceId,
  onToggleCamera,
  onToggleMic,
  onSettings,
  onLeave,
  admitted,
  onEnter,
  error
}: {
  meeting: Meeting;
  cameraEnabled: boolean;
  micEnabled: boolean;
  cameraDeviceId: string;
  onToggleCamera: () => void;
  onToggleMic: () => void;
  onSettings: () => void;
  onLeave: () => void;
  admitted: boolean;
  onEnter: () => void;
  error: string | null;
}) {
  return (
    <ScreenFrame title={meeting.title}>
      <div className="workbench">
        <section className="preview-column">
          <VideoPreview enabled={cameraEnabled} label="Vista previa" cameraDeviceId={cameraDeviceId} />
          <div className="control-row">
            <ControlButton active={micEnabled} icon={micEnabled ? <Mic /> : <MicOff />} label="Mic" onClick={onToggleMic} />
            <ControlButton active={cameraEnabled} icon={cameraEnabled ? <Video /> : <VideoOff />} label="Cámara" onClick={onToggleCamera} />
            <ControlButton icon={<Settings />} label="Ajustes" onClick={onSettings} />
          </div>
        </section>
        <aside className="side-panel waiting-panel">
          <h1>Listo para entrar</h1>
          <InlineNotice icon={admitted ? <Check /> : <RefreshCw />}>
            {admitted ? "Admitido por el host" : "Esperando admisión"}
          </InlineNotice>
          {error ? <InlineNotice icon={<ShieldAlert />}>{error}</InlineNotice> : null}
          <Button icon={<LogOut />} variant="outline" onClick={onLeave}>
            Salir de la sala
          </Button>
          <Button icon={<ArrowRight />} onClick={onEnter} disabled={!admitted}>
            Entrar
          </Button>
        </aside>
      </div>
    </ScreenFrame>
  );
}

function ActiveCallScreen({
  meeting,
  liveKitConnection,
  hostMode,
  hostToken,
  identity,
  deviceSelection,
  cameraEnabled,
  micEnabled,
  faceEnabled,
  backgroundEnabled,
  backgroundCalibration,
  voiceEnabled,
  mediaSyncError,
  onToggleCamera,
  onToggleMic,
  onAdmitParticipant,
  onLeave
}: {
  meeting: Meeting;
  liveKitConnection: (LiveKitConnection & { warning?: string }) | null;
  hostMode: boolean;
  hostToken: string | null;
  identity: HostIdentity | null;
  deviceSelection: DeviceSelection;
  cameraEnabled: boolean;
  micEnabled: boolean;
  faceEnabled: boolean;
  backgroundEnabled: boolean;
  backgroundCalibration: BackgroundCalibration | null;
  voiceEnabled: boolean;
  mediaSyncError: string | null;
  onToggleCamera: () => void;
  onToggleMic: () => void;
  onAdmitParticipant: (participantId: string) => void;
  onLeave: () => void;
}) {
  const [room, setRoom] = useState<Room | null>(null);
  const [liveKitState, setLiveKitState] = useState<"offline" | "connecting" | "connected" | "error">("offline");
  const [liveKitError, setLiveKitError] = useState<string | null>(null);
  const [callActionError, setCallActionError] = useState<string | null>(null);
  const [aiSession, setAiSession] = useState<AiSession | null>(null);
  const [aiSessionError, setAiSessionError] = useState<string | null>(null);
  const [processedVideoState, setProcessedVideoState] = useState<"idle" | "publishing" | "published" | "error">("idle");
  const [processedRuntimeStatus, setProcessedRuntimeStatus] = useState<ProcessedVideoRuntimeStatus | null>(null);
  const [processedAudioState, setProcessedAudioState] = useState<"idle" | "publishing" | "published" | "error">("idle");
  const [processedAudioRuntimeStatus, setProcessedAudioRuntimeStatus] = useState<ProcessedAudioRuntimeStatus | null>(null);
  const [roomMediaVersion, setRoomMediaVersion] = useState(0);
  const [screenShareEnabled, setScreenShareEnabled] = useState(false);
  const [screenShareState, setScreenShareState] = useState<"idle" | "starting" | "sharing" | "error">("idle");
  const [sideTab, setSideTab] = useState<"participants" | "chat">("participants");
  const [callDiagnosticsOpen, setCallDiagnosticsOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<CallChatMessage[]>([]);
  const [chatDraft, setChatDraft] = useState("");
  const [chatError, setChatError] = useState<string | null>(null);
  const processedAudioRef = useRef<ProcessedAudioPipeline | null>(null);
  const processedVideoRef = useRef<ProcessedVideoPipeline | null>(null);
  const activeParticipants = useMemo(() => {
    const joined = meeting.participants.filter((participant) => participant.joinedAt && !participant.leftAt);
    const participants = joined.length > 0 ? joined : meeting.participants;

    return participants.slice(0, 4);
  }, [meeting.participants]);
  const waitingParticipants = useMemo(
    () =>
      meeting.participants.filter(
        (participant) => participant.role !== "host" && !participant.joinedAt && !participant.leftAt
      ),
    [meeting.participants]
  );
  const fallbackParticipants = useMemo(() => {
    const activeIds = new Set(activeParticipants.map((participant) => participant.id));
    const visibleWaitingParticipants = hostMode
      ? waitingParticipants.filter((participant) => !activeIds.has(participant.id))
      : [];

    return [...activeParticipants, ...visibleWaitingParticipants].slice(0, 4);
  }, [activeParticipants, hostMode, waitingParticipants]);
  const hostDisplayName = activeParticipants.find((participant) => participant.role === "host")?.displayName ?? "Host";
  const localDisplayName =
    meeting.participants.find((participant) => participant.id === liveKitConnection?.identity)?.displayName ??
    (hostMode ? hostDisplayName : "Tú");
  const liveKitUrl = liveKitConnection?.url ?? null;
  const liveKitToken = liveKitConnection?.token ?? null;
  const liveKitWarning = liveKitConnection?.warning ?? null;

  useEffect(() => {
    if (!liveKitUrl || !liveKitToken) {
      setLiveKitState("offline");
      setLiveKitError(liveKitWarning ?? "LiveKit no está configurado.");
      return;
    }

    let activeRoom: Room | null = null;
    let cancelled = false;
    let startTimer: number | null = null;
    setLiveKitState("connecting");
    setLiveKitError(null);

    // Defer slightly so route changes can cancel before opening a WebRTC connection.
    startTimer = window.setTimeout(() => {
      if (cancelled) return;

      void connectLiveKitRoom({ url: liveKitUrl, token: liveKitToken })
        .then(async (connectedRoom) => {
          if (cancelled) {
            connectedRoom.disconnect();
            return;
          }

          activeRoom = connectedRoom;
          setRoom(connectedRoom);
          setLiveKitState("connected");
          setLiveKitError(null);
          void connectedRoom.startAudio().catch(() => undefined);
        })
        .catch((error) => {
          if (cancelled) return;
          setLiveKitState("error");
          setLiveKitError(error instanceof Error ? error.message : "No se pudo conectar LiveKit.");
        });
    }, 250);

    return () => {
      cancelled = true;
      if (startTimer !== null) {
        window.clearTimeout(startTimer);
      }
      activeRoom?.disconnect();
      setRoom(null);
    };
  }, [liveKitToken, liveKitUrl, liveKitWarning]);

  useEffect(() => {
    if (!room) return;

    const refreshMedia = () => setRoomMediaVersion((value) => value + 1);
    const handleLocalTrackPublished = (publication: TrackPublication) => {
      refreshMedia();
      if (publication.source === Track.Source.ScreenShare) {
        setScreenShareEnabled(true);
        setScreenShareState("sharing");
      }
    };
    const handleLocalTrackUnpublished = (publication: TrackPublication) => {
      refreshMedia();
      if (publication.source === Track.Source.ScreenShare) {
        setScreenShareEnabled(false);
        setScreenShareState("idle");
      }
    };

    room.on(RoomEvent.ParticipantConnected, refreshMedia);
    room.on(RoomEvent.ParticipantDisconnected, refreshMedia);
    room.on(RoomEvent.TrackSubscribed, refreshMedia);
    room.on(RoomEvent.TrackUnsubscribed, refreshMedia);
    room.on(RoomEvent.TrackMuted, refreshMedia);
    room.on(RoomEvent.TrackUnmuted, refreshMedia);
    room.on(RoomEvent.LocalTrackPublished, handleLocalTrackPublished);
    room.on(RoomEvent.LocalTrackUnpublished, handleLocalTrackUnpublished);
    room.on(RoomEvent.ParticipantNameChanged, refreshMedia);
    room.on(RoomEvent.ConnectionQualityChanged, refreshMedia);
    refreshMedia();

    return () => {
      room.off(RoomEvent.ParticipantConnected, refreshMedia);
      room.off(RoomEvent.ParticipantDisconnected, refreshMedia);
      room.off(RoomEvent.TrackSubscribed, refreshMedia);
      room.off(RoomEvent.TrackUnsubscribed, refreshMedia);
      room.off(RoomEvent.TrackMuted, refreshMedia);
      room.off(RoomEvent.TrackUnmuted, refreshMedia);
      room.off(RoomEvent.LocalTrackPublished, handleLocalTrackPublished);
      room.off(RoomEvent.LocalTrackUnpublished, handleLocalTrackUnpublished);
      room.off(RoomEvent.ParticipantNameChanged, refreshMedia);
      room.off(RoomEvent.ConnectionQualityChanged, refreshMedia);
    };
  }, [room]);

  useEffect(() => {
    if (!room) return;

    const handleDataReceived = (payload: Uint8Array, participant?: Participant, _kind?: unknown, topic?: string) => {
      if (topic !== CALL_CHAT_TOPIC || !participant) return;

      const message = decodeChatMessage(payload, participant);
      if (!message) return;
      setChatMessages((current) => (current.some((item) => item.id === message.id) ? current : [...current, message]));
    };

    room.on(RoomEvent.DataReceived, handleDataReceived);
    return () => {
      room.off(RoomEvent.DataReceived, handleDataReceived);
    };
  }, [room]);

  useEffect(() => {
    if (!room) return;

    const activeRoom = room;
    let cancelled = false;
    let publishedTrack: MediaStreamTrack | null = null;
    const shouldProcessAudio = hostMode && micEnabled && voiceEnabled;

    async function publishAudio() {
      processedAudioRef.current?.stop();
      processedAudioRef.current = null;

      if (!micEnabled) {
        setProcessedAudioState("idle");
        setProcessedAudioRuntimeStatus(null);
        await activeRoom.localParticipant.setMicrophoneEnabled(false);
        setCallActionError(null);
        return;
      }

      if (!shouldProcessAudio) {
        setProcessedAudioState("idle");
        setProcessedAudioRuntimeStatus(null);
        await activeRoom.localParticipant.setMicrophoneEnabled(true, audioCaptureOptions(deviceSelection.microphoneId));
        setCallActionError(null);
        return;
      }

      setProcessedAudioState("publishing");
      await activeRoom.localParticipant.setMicrophoneEnabled(false);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: mediaTrackAudioConstraints(deviceSelection.microphoneId),
        video: false
      });
      const [microphoneTrack] = stream.getAudioTracks();

      if (!microphoneTrack) {
        throw new Error("No se pudo abrir micrófono para el pipeline de voz.");
      }

      const pipeline = await createProcessedAudioPipeline(microphoneTrack, {
        voiceEnabled,
        aiSessionId: aiSession?.id ?? null,
        onStatusChange: setProcessedAudioRuntimeStatus
      });

      if (cancelled) {
        pipeline.stop();
        return;
      }

      processedAudioRef.current = pipeline;
      publishedTrack = pipeline.track;
      await activeRoom.localParticipant.publishTrack(pipeline.track, {
        name: "shape-processed-audio",
        source: Track.Source.Microphone,
        stream: "shape-processed"
      });
      setProcessedAudioState("published");
      setCallActionError(null);
    }

    void publishAudio().catch((error) => {
      setProcessedAudioState("error");
      processedAudioRef.current?.stop();
      processedAudioRef.current = null;
      setCallActionError(error instanceof Error ? error.message : "No se pudo publicar voz procesada.");
      void activeRoom.localParticipant.setMicrophoneEnabled(micEnabled, audioCaptureOptions(deviceSelection.microphoneId));
    });

    return () => {
      cancelled = true;
      if (publishedTrack) {
        void activeRoom.localParticipant.unpublishTrack(publishedTrack, true);
      }
      processedAudioRef.current?.stop();
      processedAudioRef.current = null;
    };
  }, [aiSession?.id, deviceSelection.microphoneId, hostMode, micEnabled, room, voiceEnabled]);

  useEffect(() => {
    if (!room) return;

    let cancelled = false;
    let publishedTrack: MediaStreamTrack | null = null;
    const shouldProcessVideo = hostMode && cameraEnabled && (faceEnabled || backgroundEnabled);

    async function publishVideo() {
      processedVideoRef.current?.stop();
      processedVideoRef.current = null;

      if (!cameraEnabled) {
        setProcessedVideoState("idle");
        setProcessedRuntimeStatus(null);
        await room?.localParticipant.setCameraEnabled(false);
        setCallActionError(null);
        return;
      }

      if (!shouldProcessVideo) {
        setProcessedVideoState("idle");
        setProcessedRuntimeStatus(null);
        await room?.localParticipant.setCameraEnabled(true, videoCaptureOptions(deviceSelection.cameraId));
        setCallActionError(null);
        return;
      }

      setProcessedVideoState("publishing");
      await room?.localParticipant.setCameraEnabled(false);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: mediaTrackVideoConstraints(deviceSelection.cameraId),
        audio: false
      });
      const [cameraTrack] = stream.getVideoTracks();

      if (!cameraTrack) {
        throw new Error("No se pudo abrir cámara para el pipeline local.");
      }

      const pipeline = await createProcessedVideoPipeline(cameraTrack, {
        faceEnabled,
        backgroundEnabled,
        voiceEnabled,
        label: hostDisplayName,
        aiSessionId: aiSession?.id ?? null,
        sidecarFps: 12,
        onStatusChange: setProcessedRuntimeStatus
      });

      if (cancelled) {
        pipeline.stop();
        return;
      }

      processedVideoRef.current = pipeline;
      publishedTrack = pipeline.track;
      await room?.localParticipant.publishTrack(pipeline.track, {
        name: "shape-processed-video",
        source: Track.Source.Camera,
        stream: "shape-processed"
      });
      setProcessedVideoState("published");
      setCallActionError(null);
    }

    void publishVideo().catch((error) => {
      setProcessedVideoState("error");
      setCallActionError(error instanceof Error ? error.message : "No se pudo publicar video procesado.");
      void room.localParticipant.setCameraEnabled(cameraEnabled);
    });

    return () => {
      cancelled = true;
      if (publishedTrack) {
        void room.localParticipant.unpublishTrack(publishedTrack, true);
      }
      processedVideoRef.current?.stop();
      processedVideoRef.current = null;
    };
  }, [aiSession?.id, backgroundEnabled, cameraEnabled, deviceSelection.cameraId, faceEnabled, hostDisplayName, hostMode, room, voiceEnabled]);

  useEffect(() => {
    if (!hostMode || !liveKitConnection?.identity) {
      setAiSession(null);
      return;
    }

    let cancelled = false;
    let sessionId: string | null = null;
    const participantIdentity = liveKitConnection.identity;
    setAiSessionError(null);

    async function startLocalAiSession() {
      const prepared = faceEnabled ? await prepareIdentityForAiSession(identity, hostToken) : { identity, cache: null };
      const resolvedIdentity = prepared.identity;
      const artifactCache = prepared.cache;

      if (cancelled) {
        return;
      }

      const session = await startAiSession({
        meetingCode: meeting.code,
        participantId: participantIdentity,
        identityId: resolvedIdentity?.id ?? null,
        identityKind: resolvedIdentity?.kind,
        identityVersion: resolvedIdentity?.version,
        identityArtifactUri: resolvedIdentity?.artifactUri ?? null,
        identityCachedArtifactUri: artifactCache?.uri ?? resolvedIdentity?.artifactUri ?? null,
        identityLocalArtifactPath: artifactCache?.localPath ?? null,
        identityArtifactSha256: artifactCache?.sha256 ?? resolvedIdentity?.artifactSha256 ?? null,
        identityArtifactSizeBytes: artifactCache?.sizeBytes ?? resolvedIdentity?.artifactSizeBytes ?? null,
        identityArtifactCacheMessage: artifactCache?.message ?? null,
        faceEnabled,
        backgroundEnabled,
        backgroundCleanPlateDataUrl: backgroundCalibration?.cleanPlateDataUrl ?? null,
        backgroundCleanPlateCapturedAt: backgroundCalibration?.capturedAt ?? null,
        backgroundCleanPlateWidth: backgroundCalibration?.width ?? null,
        backgroundCleanPlateHeight: backgroundCalibration?.height ?? null,
        backgroundCleanPlateCameraDeviceId: backgroundCalibration?.cameraDeviceId ?? null,
        voiceEnabled,
        targetWidth: 1280,
        targetHeight: 720,
        targetFps: 30
      });

      return session;
    }

    void startLocalAiSession()
      .then((session) => {
        if (!session) return;
        sessionId = session.id;
        if (cancelled) {
          void stopAiSession(session.id);
          return;
        }
        setAiSession(session);
      })
      .catch((error) => {
        setAiSessionError(error instanceof Error ? error.message : "No se pudo iniciar la sesión local de IA.");
      });

    return () => {
      cancelled = true;
      if (sessionId) {
        void stopAiSession(sessionId);
      }
    };
  }, [backgroundCalibration, backgroundEnabled, faceEnabled, hostMode, hostToken, identity, liveKitConnection?.identity, meeting.code, voiceEnabled]);

  useEffect(() => {
    if (!aiSession?.id || aiSession.status !== "running") return;

    const interval = window.setInterval(() => {
      void getAiSession(aiSession.id)
        .then(setAiSession)
        .catch((error) => setAiSessionError(error instanceof Error ? error.message : "No se pudo actualizar la sesión IA."));
    }, 2000);

    return () => window.clearInterval(interval);
  }, [aiSession?.id, aiSession?.status]);

  async function handleToggleScreenShare() {
    if (!room) {
      setCallActionError("Compartir pantalla requiere LiveKit conectado.");
      return;
    }

    const nextEnabled = !screenShareEnabled;
    setScreenShareState(nextEnabled ? "starting" : "idle");

    try {
      await room.localParticipant.setScreenShareEnabled(
        nextEnabled,
        nextEnabled
          ? {
              audio: false,
              video: true,
              resolution: { width: 1920, height: 1080, frameRate: 15 }
            }
          : undefined
      );
      setScreenShareEnabled(nextEnabled);
      setScreenShareState(nextEnabled ? "sharing" : "idle");
      setCallActionError(null);
    } catch (error) {
      setScreenShareState("error");
      setCallActionError(error instanceof Error ? error.message : "No se pudo compartir pantalla.");
    }
  }

  async function handleSendChatMessage() {
    const body = chatDraft.trim();
    if (!body) return;

    const localMessage: CallChatMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      participantId: liveKitConnection?.identity ?? "local",
      displayName: localDisplayName,
      body,
      sentAt: new Date().toISOString(),
      local: true
    };

    setChatDraft("");
    setChatMessages((current) => [...current, localMessage]);

    if (!room || liveKitState !== "connected") {
      setChatError("Chat pendiente de conexión LiveKit.");
      return;
    }

    try {
      await room.localParticipant.publishData(encodeChatMessage(localMessage), {
        reliable: true,
        topic: CALL_CHAT_TOPIC
      });
      setChatError(null);
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "No se pudo enviar el mensaje.");
    }
  }

  const metrics = useMemo<PipelineMetric[]>(
    () =>
      defaultPipelineMetrics.map((metric) => {
        if (metric.label === "Video") {
          if (processedVideoState === "published") return { ...metric, value: "Track IA publicado", state: "ok" };
          if (processedVideoState === "publishing") return { ...metric, value: "Publicando IA", state: "warning" };
          if (processedVideoState === "error") return { ...metric, value: "IA fallback", state: "warning" };
          if (liveKitState === "connected") return { ...metric, value: "LiveKit conectado", state: "ok" };
          if (liveKitState === "connecting") return { ...metric, value: "Conectando LiveKit", state: "warning" };
          if (liveKitState === "error") return { ...metric, value: "LiveKit error", state: "warning" };
          return { ...metric, value: "Modo local", state: "idle" };
        }
        if (metric.label === "Rostro") return { ...metric, value: pipelineValue(aiSession, "face", faceEnabled), state: faceEnabled ? "ok" : "idle" };
        if (metric.label === "Fondo") return { ...metric, value: pipelineValue(aiSession, "background", backgroundEnabled), state: backgroundEnabled ? "ok" : "idle" };
        if (metric.label === "Voz") {
          if (voiceEnabled && processedAudioState === "published") {
            const latency = processedAudioRuntimeStatus?.latencyMs ? `${processedAudioRuntimeStatus.latencyMs} ms` : null;
            return { ...metric, value: latency ? `Bridge voz · ${latency}` : "Track voz publicado", state: "ok" };
          }
          if (voiceEnabled && processedAudioState === "publishing") return { ...metric, value: "Publicando voz", state: "warning" };
          if (voiceEnabled && processedAudioState === "error") return { ...metric, value: "Voz fallback", state: "warning" };
          return { ...metric, value: pipelineValue(aiSession, "voice", voiceEnabled), state: voiceEnabled ? "ok" : "idle" };
        }
        return metric;
      }),
    [aiSession, backgroundEnabled, faceEnabled, liveKitState, processedAudioRuntimeStatus?.latencyMs, processedAudioState, processedVideoState, voiceEnabled]
  );
  const fallbackTiles = useMemo(
    () => fallbackParticipants.map((participant) => fallbackTileFromMeetingParticipant(participant, liveKitConnection?.identity ?? null, { faceEnabled, backgroundEnabled, voiceEnabled })),
    [backgroundEnabled, faceEnabled, fallbackParticipants, liveKitConnection?.identity, voiceEnabled]
  );
  const liveKitTiles = useMemo(
    () =>
      room
        ? buildLiveKitTiles(room, meeting, hostMode, liveKitConnection?.identity ?? null, {
            faceEnabled,
            backgroundEnabled,
            voiceEnabled
          })
        : [],
    [backgroundEnabled, faceEnabled, hostMode, liveKitConnection?.identity, meeting, room, roomMediaVersion, voiceEnabled]
  );
  const visibleTiles = liveKitTiles.length > 0 ? liveKitTiles : fallbackTiles;
  const [primaryTile, ...secondaryTiles] = visibleTiles;
  const secondaryPlaceholderCount = hostMode ? Math.max(0, 2 - secondaryTiles.length) : 0;
  const hasSecondaryColumn = secondaryTiles.length > 0 || secondaryPlaceholderCount > 0;
  const visibleParticipantCount = Math.max(activeParticipants.length, 1);
  const liveKitDiagnosticDetail = liveKitState === "error" || liveKitState === "offline" || liveKitWarning ? liveKitError : null;

  return (
    <section className="screen call-screen">
      <header className="call-topbar">
        <div className="meeting-title">
          <LogoMark />
          <div>
            <strong>{meeting.title}</strong>
            <span>{visibleParticipantCount} participante{visibleParticipantCount === 1 ? "" : "s"} · {meeting.code}</span>
          </div>
        </div>
        <div className="top-actions">
          <Button variant={sideTab === "participants" ? "soft" : "ghost"} icon={<Users />} onClick={() => setSideTab("participants")}>Participantes</Button>
          <Button variant={sideTab === "chat" ? "soft" : "ghost"} icon={<Send />} onClick={() => setSideTab("chat")}>Chat</Button>
          <Button variant={callDiagnosticsOpen ? "soft" : "ghost"} icon={<Settings />} onClick={() => setCallDiagnosticsOpen((value) => !value)}>Más</Button>
        </div>
      </header>
      <div className="call-body">
        <section className="call-stage">
          <div className={hasSecondaryColumn ? "video-grid" : "video-grid single"}>
            {primaryTile ? <VideoTile primary tile={primaryTile} /> : null}
            {hasSecondaryColumn ? (
              <div className="secondary-video-stack">
                {secondaryTiles.map((participant) => (
                  <VideoTile key={participant.id} tile={participant} />
                ))}
                {Array.from({ length: secondaryPlaceholderCount }).map((_, index) => (
                  <EmptyVideoSlot key={`empty-slot-${index}`} />
                ))}
              </div>
            ) : null}
          </div>
          <RemoteAudioTracks tiles={visibleTiles} speakerId={deviceSelection.speakerId} />
          <div className="call-controls">
            <CircleButton active={micEnabled} icon={micEnabled ? <Mic /> : <MicOff />} onClick={onToggleMic} />
            <CircleButton active={cameraEnabled} icon={cameraEnabled ? <Video /> : <VideoOff />} onClick={onToggleCamera} />
            <CircleButton active={sideTab === "participants"} icon={<Users />} title="Participantes" onClick={() => setSideTab("participants")} />
            <CircleButton
              active={screenShareEnabled}
              disabled={!room || screenShareState === "starting"}
              icon={<ScreenShare />}
              title={screenShareEnabled ? "Detener pantalla" : "Compartir pantalla"}
              onClick={() => void handleToggleScreenShare()}
            />
            <CircleButton
              active={callDiagnosticsOpen}
              icon={<Settings />}
              title="Diagnóstico"
              onClick={() => setCallDiagnosticsOpen((value) => !value)}
            />
            <CircleButton danger icon={<PhoneOff />} title={hostMode ? "Finalizar reunión" : "Salir"} onClick={onLeave} />
          </div>
        </section>
        <aside className="call-side">
          <div className="tabs">
            <button className={sideTab === "participants" ? "active" : ""} onClick={() => setSideTab("participants")}>Participantes</button>
            <button className={sideTab === "chat" ? "active" : ""} onClick={() => setSideTab("chat")}>Chat</button>
          </div>
          <Panel title="Participantes">
            {activeParticipants.map((participant) => (
              <ParticipantLine key={participant.id} name={participant.displayName} meta={participant.role === "host" ? "Host" : "Invitada"} />
            ))}
            {hostMode && waitingParticipants.map((participant) => (
              <WaitingParticipantLine
                key={participant.id}
                participant={participant}
                onAdmit={() => onAdmitParticipant(participant.id)}
              />
            ))}
          </Panel>
          <Panel title="Chat de reunión">
            <div className="chat-list">
              {chatMessages.length > 0 ? (
                chatMessages.map((message) => <ChatBubble key={message.id} message={message} />)
              ) : (
                <div className="chat-empty">Sin mensajes.</div>
              )}
            </div>
            {chatError ? <InlineNotice icon={<ShieldAlert />}>{chatError}</InlineNotice> : null}
            <form
              className="chat-compose"
              onSubmit={(event) => {
                event.preventDefault();
                void handleSendChatMessage();
              }}
            >
              <input value={chatDraft} onChange={(event) => setChatDraft(event.target.value)} placeholder="Mensaje" />
              <button disabled={!chatDraft.trim()} type="submit">
                <Send />
              </button>
            </form>
          </Panel>
          {callDiagnosticsOpen ? (
            <details
              className="panel debug-details call-diagnostics"
              open={callDiagnosticsOpen}
              onToggle={(event) => setCallDiagnosticsOpen(event.currentTarget.open)}
            >
              <summary>Diagnóstico</summary>
              <div className="debug-details-body">
                {metrics.map((metric) => (
                  <StatusRow key={metric.label} label={metric.label} value={metric.value} tone={metric.state} />
                ))}
                <StatusRow
                  label="Pantalla"
                  value={screenShareState === "sharing" ? "Compartiendo" : screenShareState === "starting" ? "Iniciando" : screenShareState === "error" ? "Error" : "Sin compartir"}
                  tone={screenShareState === "sharing" ? "ok" : screenShareState === "error" ? "warning" : "idle"}
                />
                {hostMode ? (
                  <StatusRow
                    label="IA local"
                    value={aiSessionError ? "Error de sesión" : aiSession ? `${aiSession.metrics.fps} FPS · ${aiSession.metrics.latencyMs} ms` : "Iniciando sesión"}
                    tone={aiSessionError ? "warning" : aiSession ? "ok" : "idle"}
                  />
                ) : null}
                {processedRuntimeStatus ? (
                  <StatusRow
                    label="Bridge"
                    value={processedRuntimeStatus.latencyMs ? `${processedRuntimeStatus.latencyMs} ms · ${processedRuntimeStatus.mode}` : processedRuntimeStatus.message}
                    tone={processedRuntimeStatus.state === "processing" ? "ok" : processedRuntimeStatus.state === "fallback" ? "warning" : "idle"}
                  />
                ) : null}
                {processedAudioRuntimeStatus ? (
                  <StatusRow
                    label="Bridge voz"
                    value={
                      processedAudioRuntimeStatus.latencyMs
                        ? `${processedAudioRuntimeStatus.latencyMs} ms · ${processedAudioRuntimeStatus.processor ?? processedAudioRuntimeStatus.mode}`
                        : processedAudioRuntimeStatus.message
                    }
                    tone={processedAudioRuntimeStatus.state === "processing" ? "ok" : processedAudioRuntimeStatus.state === "fallback" ? "warning" : "idle"}
                  />
                ) : null}
                {liveKitDiagnosticDetail ? <StatusRow label="LiveKit" value={liveKitDiagnosticDetail} tone="warning" /> : null}
                {mediaSyncError ? <StatusRow label="Servidor" value={mediaSyncError} tone="warning" /> : null}
                {callActionError ? <StatusRow label="Acción" value={callActionError} tone="warning" /> : null}
                {processedRuntimeStatus?.lastError ? <StatusRow label="Frames" value={processedRuntimeStatus.lastError} tone="warning" /> : null}
                {processedAudioRuntimeStatus?.lastError ? <StatusRow label="Voz" value={processedAudioRuntimeStatus.lastError} tone="warning" /> : null}
                {aiSessionError ? <StatusRow label="Sidecar" value={aiSessionError} tone="warning" /> : null}
              </div>
            </details>
          ) : null}
        </aside>
      </div>
    </section>
  );
}

function pipelineValue(session: AiSession | null, pipelineId: "face" | "background" | "voice", enabled: boolean) {
  if (!enabled) return "Sin activar";

  const pipeline = session?.pipelines.find((item) => item.id === pipelineId);
  if (!session || !pipeline) return "Iniciando";
  if (pipeline.status === "running") return pipeline.model;
  return pipeline.status === "standby" ? "En espera" : pipeline.status;
}

function encodeChatMessage(message: CallChatMessage): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      id: message.id,
      displayName: message.displayName,
      body: message.body,
      sentAt: message.sentAt
    })
  );
}

function decodeChatMessage(payload: Uint8Array, participant: Participant): CallChatMessage | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(payload)) as Partial<CallChatMessage>;
    if (!parsed.id || !parsed.body || !parsed.sentAt) return null;

    return {
      id: parsed.id,
      participantId: participant.identity,
      displayName: parsed.displayName || participant.name || participant.identity,
      body: parsed.body,
      sentAt: parsed.sentAt,
      local: false
    };
  } catch {
    return null;
  }
}

function formatChatTime(value: string) {
  return new Intl.DateTimeFormat("es-CO", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Bogota"
  }).format(new Date(value));
}

function buildLiveKitTiles(
  room: Room,
  meeting: Meeting,
  hostMode: boolean,
  localIdentity: string | null,
  effects: NonNullable<CallTile["effects"]>
) {
  const meetingByParticipantId = new Map(meeting.participants.map((participant) => [participant.id, participant]));
  const liveParticipants: Array<{ participant: Participant; isLocal: boolean }> = [
    { participant: room.localParticipant, isLocal: true },
    ...Array.from(room.remoteParticipants.values()).map((participant) => ({ participant, isLocal: false }))
  ];
  const tiles = liveParticipants.flatMap(({ participant, isLocal }) => {
    const participantTiles: CallTile[] = [];
    const screenTile = screenTileFromLiveKitParticipant(participant, meetingByParticipantId, isLocal);
    if (screenTile) participantTiles.push(screenTile);
    participantTiles.push(tileFromLiveKitParticipant(participant, meetingByParticipantId, isLocal, effects));
    return participantTiles;
  });
  const knownIdentities = new Set(tiles.map((tile) => tile.identity));

  meeting.participants
    .filter((participant) => participant.joinedAt && !participant.leftAt && !knownIdentities.has(participant.id))
    .forEach((participant) => {
      tiles.push(fallbackTileFromMeetingParticipant(participant, localIdentity, effects));
    });

  return tiles
    .sort((left, right) => compareCallTiles(left, right, hostMode))
    .slice(0, 4);
}

function tileFromLiveKitParticipant(
  participant: Participant,
  meetingByParticipantId: Map<string, Meeting["participants"][number]>,
  isLocal: boolean,
  effects: NonNullable<CallTile["effects"]>
): CallTile {
  const meetingParticipant = meetingByParticipantId.get(participant.identity);
  const videoPublication = participant.getTrackPublication(Track.Source.Camera) ?? firstPublication(participant.videoTrackPublications);
  const audioPublication = participant.getTrackPublication(Track.Source.Microphone) ?? firstPublication(participant.audioTrackPublications);
  const role = meetingParticipant?.role ?? "guest";
  const videoTrack = videoPublication?.videoTrack;
  const audioTrack = audioPublication?.audioTrack;

  return {
    id: participant.sid || participant.identity,
    identity: participant.identity,
    label: participant.name || meetingParticipant?.displayName || (isLocal ? "Tú" : participant.identity),
    role,
    isLocal,
    source: "camera",
    cameraOn: Boolean(videoTrack && !videoPublication?.isMuted),
    micOn: Boolean(audioTrack && !audioPublication?.isMuted),
    videoTrack,
    audioTrack,
    effects: role === "host" ? effects : undefined
  };
}

function screenTileFromLiveKitParticipant(
  participant: Participant,
  meetingByParticipantId: Map<string, Meeting["participants"][number]>,
  isLocal: boolean
): CallTile | null {
  const publication = participant.getTrackPublication(Track.Source.ScreenShare);
  const videoTrack = publication?.videoTrack;

  if (!publication || !videoTrack || publication.isMuted) return null;

  const meetingParticipant = meetingByParticipantId.get(participant.identity);
  const role = meetingParticipant?.role ?? "guest";
  const label = participant.name || meetingParticipant?.displayName || (isLocal ? "Tú" : participant.identity);

  return {
    id: `${participant.sid || participant.identity}_screen`,
    identity: `${participant.identity}:screen`,
    label: `${label} · pantalla`,
    role,
    isLocal,
    source: "screen",
    cameraOn: true,
    micOn: true,
    videoTrack
  };
}

function fallbackTileFromMeetingParticipant(
  participant: Meeting["participants"][number],
  localIdentity: string | null,
  effects: NonNullable<CallTile["effects"]>
): CallTile {
  return {
    id: participant.id,
    identity: participant.id,
    label: participant.displayName,
    role: participant.role,
    isLocal: participant.id === localIdentity,
    source: "camera",
    cameraOn: participant.camera === "on",
    micOn: participant.mic === "on",
    effects: participant.role === "host" ? effects : undefined
  };
}

function firstPublication(publications: Map<string, TrackPublication>) {
  return Array.from(publications.values())[0];
}

function compareCallTiles(left: CallTile, right: CallTile, hostMode: boolean) {
  if (left.source !== right.source) return left.source === "screen" ? -1 : 1;
  if (hostMode && left.isLocal !== right.isLocal) return left.isLocal ? -1 : 1;
  if (left.role !== right.role) return left.role === "host" ? -1 : 1;
  if (!hostMode && left.isLocal !== right.isLocal) return left.isLocal ? -1 : 1;
  return left.label.localeCompare(right.label);
}

function ScreenFrame({
  title,
  children,
  onBack,
  right
}: {
  title: string;
  children: React.ReactNode;
  onBack?: () => void;
  right?: React.ReactNode;
}) {
  const backButton = onBack ? (
    <Button variant="outline" icon={<ArrowLeft />} onClick={onBack}>
      Volver
    </Button>
  ) : null;
  const rightContent = right && backButton ? (
    <div className="topbar-actions">
      {right}
      {backButton}
    </div>
  ) : right ?? backButton;

  return (
    <section className="screen" aria-label={title}>
      <header className="topbar">
        <LogoMark />
        {rightContent}
      </header>
      {children}
    </section>
  );
}

function Brand() {
  return (
    <div className="brand">
      <LogoMark />
      <strong>Shape Meet</strong>
    </div>
  );
}

function LogoMark({ size = "normal" }: { size?: "normal" | "large" }) {
  return (
    <span className={`logo-mark ${size}`}>
      <Video />
    </span>
  );
}

function Button({
  children,
  icon,
  variant = "primary",
  ...props
}: {
  children: React.ReactNode;
  icon?: React.ReactNode;
  variant?: "primary" | "outline" | "ghost" | "soft" | "danger";
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={`button ${variant}`} type="button" {...props}>
      {icon}
      <span>{children}</span>
    </button>
  );
}

function CenteredPanel({ children, width }: { children: React.ReactNode; width: number }) {
  return (
    <div className="center-region">
      <section className="white-panel centered" style={{ width }}>
        {children}
      </section>
    </div>
  );
}

function AuthCard({ children, height = 480 }: { children: React.ReactNode; height?: number }) {
  return (
    <section className="auth-card" style={{ minHeight: height }}>
      {children}
    </section>
  );
}

function StatusIcon({ icon, tone = "primary" }: { icon: React.ReactNode; tone?: "primary" | "success" | "warning" }) {
  return <span className={`status-icon ${tone}`}>{icon}</span>;
}

function TextField({
  label,
  icon,
  value,
  onChange,
  type = "text",
  autoComplete
}: {
  label: string;
  icon: React.ReactNode;
  value: string;
  onChange?: (value: string) => void;
  type?: string;
  autoComplete?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <div className="input-shell">
        {icon}
        <input value={value} readOnly={!onChange} onChange={(event) => onChange?.(event.target.value)} type={type} autoComplete={autoComplete} />
      </div>
    </label>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
  disabled
}: {
  label: string;
  value: string;
  options?: Array<{ value: string; label: string }>;
  onChange?: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <div className="input-shell select-shell">
        {options ? (
          <select value={value} onChange={(event) => onChange?.(event.target.value)} disabled={disabled}>
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : (
          <input value={value} readOnly />
        )}
        <ChevronDown />
      </div>
    </label>
  );
}

function Checkbox({ label, checked }: { label: string; checked?: boolean }) {
  return (
    <label className="checkbox-row">
      <span className={checked ? "checkbox checked" : "checkbox"}>{checked ? <Check /> : null}</span>
      <span>{label}</span>
    </label>
  );
}

function ToggleRow({ label, checked, onClick }: { label: string; checked?: boolean; onClick?: () => void }) {
  return (
    <button className="toggle-row" type="button" onClick={onClick}>
      <span>{label}</span>
      <span className={checked ? "toggle checked" : "toggle"}>
        <span />
      </span>
    </button>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function VideoPreview({
  enabled,
  label,
  cameraDeviceId,
  darkFooter,
  footerText
}: {
  enabled: boolean;
  label: string;
  cameraDeviceId?: string;
  darkFooter?: boolean;
  footerText?: string;
}) {
  const { videoRef, active, error } = useCameraPreview({ enabled, deviceId: cameraDeviceId });

  return (
    <div className="video-preview">
      {enabled && active ? <video ref={videoRef} muted playsInline /> : null}
      {!active ? (
        <div className="avatar-preview">
          <User />
        </div>
      ) : null}
      <span className="video-badge">
        <Video />
        {label}
      </span>
      {darkFooter ? (
        <div className="video-footer">
          <strong>{footerText}</strong>
          <span>720p30 · BackgroundMattingV2</span>
        </div>
      ) : null}
      {error ? <span className="video-error">{error}</span> : null}
    </div>
  );
}

function ControlButton({
  icon,
  label,
  active = true,
  onClick
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button className={active ? "control-button active" : "control-button"} type="button" onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function CircleButton({
  icon,
  active = true,
  danger,
  disabled,
  title,
  onClick
}: {
  icon: React.ReactNode;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
}) {
  return (
    <button className={`circle-button ${active ? "active" : ""} ${danger ? "danger" : ""}`} disabled={disabled} title={title} type="button" onClick={onClick}>
      {icon}
    </button>
  );
}

function ChatBubble({ message }: { message: CallChatMessage }) {
  return (
    <article className={message.local ? "chat-bubble local" : "chat-bubble"}>
      <div>
        <strong>{message.displayName}</strong>
        <span>{formatChatTime(message.sentAt)}</span>
      </div>
      <p>{message.body}</p>
    </article>
  );
}

function VideoTile({
  tile,
  primary,
}: {
  tile: CallTile;
  primary?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const element = videoRef.current;
    if (!element || !tile.videoTrack) return;

    tile.videoTrack.attach(element);
    void element.play().catch(() => undefined);

    return () => {
      tile.videoTrack?.detach(element);
    };
  }, [tile.videoTrack]);

  return (
    <div className={`${primary ? "video-tile primary" : "video-tile"} ${tile.isLocal && tile.source === "camera" ? "local" : ""} ${tile.source === "screen" ? "screen-share" : ""}`}>
      {tile.videoTrack && tile.cameraOn ? (
        <video className="tile-video" muted playsInline ref={videoRef} />
      ) : tile.cameraOn ? (
        <div className="tile-avatar">
          {initials(tile.label)}
        </div>
      ) : (
        <div className="tile-placeholder">
          <VideoOff />
        </div>
      )}
      <div className="tile-footer">
        <div>
          <strong>{tile.label}</strong>
          <span>{tile.source === "screen" ? "Pantalla compartida" : tile.micOn ? "Audio activo" : "Mic silenciado"}</span>
        </div>
        {tile.effects ? (
          <div className="effect-dots">
            <span className={tile.effects.faceEnabled ? "on" : ""} />
            <span className={tile.effects.backgroundEnabled ? "on" : ""} />
            <span className={tile.effects.voiceEnabled ? "on" : ""} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function EmptyVideoSlot() {
  return (
    <div className="video-tile empty-video-slot">
      <div className="empty-slot-icon">
        <Plus />
      </div>
      <div className="empty-slot-copy">
        <strong>Espacio disponible</strong>
        <span>Invitado pendiente</span>
      </div>
    </div>
  );
}

function RemoteAudioTracks({ tiles, speakerId }: { tiles: CallTile[]; speakerId: string }) {
  return (
    <div className="remote-audio-layer" aria-hidden="true">
      {tiles
        .filter((tile) => tile.audioTrack && !tile.isLocal)
        .map((tile) => (
          <RemoteAudioTrackElement key={tile.identity} speakerId={speakerId} track={tile.audioTrack!} />
        ))}
    </div>
  );
}

function RemoteAudioTrackElement({ track, speakerId }: { track: LiveKitAudioTrack; speakerId: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const element = audioRef.current;
    if (!element) return;

    track.attach(element);
    if (speakerId && "setSinkId" in element) {
      void element.setSinkId(speakerId).catch(() => undefined);
    }
    void element.play().catch(() => undefined);

    return () => {
      track.detach(element);
    };
  }, [speakerId, track]);

  return <audio autoPlay ref={audioRef} />;
}

function StepDots({ active }: { active: number }) {
  return (
    <div className="step-dots">
      {["Sala", "Equipo", "Host", "Entrar"].map((step, index) => (
        <span className={index <= active ? "active" : ""} key={step}>
          {step}
        </span>
      ))}
    </div>
  );
}

function InlineNotice({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="inline-notice">
      {icon}
      <span>{children}</span>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function deviceOptions(choices: MediaDeviceChoice[], emptyLabel: string) {
  if (choices.length === 0) return [{ value: "", label: emptyLabel }];
  return choices.map((choice) => ({ value: choice.id, label: choice.label }));
}

function ParticipantLine({ name, meta }: { name: string; meta: string }) {
  return (
    <div className="participant-line">
      <span className="participant-avatar">{name.slice(0, 1)}</span>
      <div>
        <strong>{name}</strong>
        <span>{meta}</span>
      </div>
    </div>
  );
}

function WaitingParticipantLine({
  participant,
  onAdmit
}: {
  participant: Meeting["participants"][number];
  onAdmit: () => void;
}) {
  return (
    <div className="waiting-participant-line">
      <span className="participant-avatar">{participant.displayName.slice(0, 1)}</span>
      <div>
        <strong>{participant.displayName}</strong>
        <span>{participant.admittedAt ? "Admitido" : "En espera"}</span>
      </div>
      <button className="admit-button" disabled={Boolean(participant.admittedAt)} type="button" onClick={onAdmit}>
        {participant.admittedAt ? "Listo" : "Admitir"}
      </button>
    </div>
  );
}

function StatusRow({
  label,
  value,
  tone = "idle"
}: {
  label: string;
  value: string;
  tone?: "ok" | "warning" | "idle";
}) {
  return (
    <div className="status-row">
      <span>{label}</span>
      <strong className={tone} title={value}>{value}</strong>
    </div>
  );
}
