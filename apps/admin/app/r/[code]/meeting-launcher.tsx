"use client";

import {
  AlertCircle,
  Camera,
  CameraOff,
  Loader2,
  Mic,
  MicOff,
  PhoneOff,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  type Participant,
  type TrackPublication,
} from "livekit-client";

type MeetingStatus = "SCHEDULED" | "WAITING" | "LIVE" | "ENDED";
type MeetingAccess = "PUBLIC_LINK" | "INVITE_ONLY";

type PublicMeeting = {
  code: string;
  title: string;
  startsAt: string | null;
  status: MeetingStatus | null;
  access: MeetingAccess | null;
  maxParticipants: number | null;
  found: boolean;
  valid: boolean;
};

type MeetingParticipant = {
  id: string;
  displayName: string;
  role: "host" | "guest";
  mic: "on" | "muted";
  camera: "on" | "off";
  joinedAt?: string | null;
  leftAt?: string | null;
};

type GuestMeeting = {
  id: string;
  title: string;
  code: string;
  startsAt: string;
  access: MeetingAccess;
  status: MeetingStatus;
  maxParticipants: number;
  participants: MeetingParticipant[];
};

type LiveKitAccess = {
  url: string | null;
  token: string | null;
  room: string;
  identity: string;
  warning?: string | null;
};

type JoinTokenResponse = {
  meeting: GuestMeeting;
  livekit: LiveKitAccess;
  participantToken?: string | null;
};

type WaitingRoomResponse = {
  meeting: GuestMeeting;
  participantId: string;
  participantToken: string;
};

type ApiMeetingResponse = {
  meeting: GuestMeeting;
};

type WaitingAccess = {
  participantId: string;
  participantToken: string;
};

type Stage = "prejoin" | "email" | "waiting" | "joining" | "room" | "ended";
type ConnectionLabel =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "error";
type MediaWarning = {
  camera?: string;
  microphone?: string;
};

type CallTile = {
  id: string;
  identity: string;
  label: string;
  role: "host" | "guest";
  isLocal: boolean;
  cameraOn: boolean;
  micOn: boolean;
  videoTrack?: NonNullable<TrackPublication["videoTrack"]>;
};

class GuestRoomApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "GuestRoomApiError";
    this.status = status;
    this.code = code;
  }
}

export function MeetingLauncher({
  meeting,
  nativeUrl,
}: {
  meeting: PublicMeeting;
  nativeUrl: string | null;
}) {
  const [stage, setStage] = useState<Stage>("prejoin");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [micEnabled, setMicEnabled] = useState(true);
  const [mediaWarning, setMediaWarning] = useState<MediaWarning>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activeMeeting, setActiveMeeting] = useState<GuestMeeting | null>(null);
  const [waitingAccess, setWaitingAccess] = useState<WaitingAccess | null>(
    null,
  );
  const [participantToken, setParticipantToken] = useState<string | null>(null);
  const [participantId, setParticipantId] = useState<string | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [connectionState, setConnectionState] =
    useState<ConnectionLabel>("idle");
  const [roomMessage, setRoomMessage] = useState<string | null>(null);
  const [roomMediaVersion, setRoomMediaVersion] = useState(0);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [micBusy, setMicBusy] = useState(false);
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const leavingRef = useRef(false);
  const connectingRoomRef = useRef<Room | null>(null);
  const previewStreamRef = useRef<MediaStream | null>(null);
  const latestJoinInputRef = useRef({
    camera: cameraEnabled,
    microphone: micEnabled,
  });

  useEffect(() => {
    latestJoinInputRef.current = {
      camera: cameraEnabled,
      microphone: micEnabled,
    };
  }, [cameraEnabled, micEnabled]);

  useEffect(() => {
    previewStreamRef.current = previewStream;
  }, [previewStream]);

  useEffect(() => {
    if (stage !== "prejoin" && stage !== "email") return undefined;
    if (!meeting.valid || !meeting.found || meeting.status === "ENDED")
      return undefined;
    if (!cameraEnabled) {
      setPreviewStream(null);
      return undefined;
    }

    let cancelled = false;
    let localStream: MediaStream | null = null;

    void navigator.mediaDevices
      ?.getUserMedia({
        audio: false,
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: "user",
        },
      })
      .then((stream) => {
        if (cancelled) {
          stopStream(stream);
          return;
        }
        localStream = stream;
        setPreviewStream(stream);
        setMediaWarning((current) => ({ ...current, camera: undefined }));
      })
      .catch(() => {
        if (cancelled) return;
        setCameraEnabled(false);
        setPreviewStream(null);
        setMediaWarning((current) => ({
          ...current,
          camera:
            "No pudimos activar la cámara. Puedes entrar solo para ver y escuchar.",
        }));
      });

    return () => {
      cancelled = true;
      if (localStream) stopStream(localStream);
    };
  }, [cameraEnabled, meeting.found, meeting.status, meeting.valid, stage]);

  useEffect(() => {
    const element = previewVideoRef.current;
    if (!element) return;

    element.srcObject = previewStream;
    if (previewStream) void element.play().catch(() => undefined);
  }, [previewStream]);

  useEffect(() => {
    if (stage !== "prejoin" && stage !== "email") return;
    if (!meeting.valid || !meeting.found || meeting.status === "ENDED") return;
    if (!micEnabled) return;

    let cancelled = false;

    void navigator.mediaDevices
      ?.getUserMedia({ audio: true, video: false })
      .then((stream) => {
        stopStream(stream);
        if (cancelled) return;
        setMediaWarning((current) => ({ ...current, microphone: undefined }));
      })
      .catch(() => {
        if (cancelled) return;
        setMicEnabled(false);
        setMediaWarning((current) => ({
          ...current,
          microphone:
            "No pudimos activar el micrófono. Puedes entrar sin hablar.",
        }));
      });

    return () => {
      cancelled = true;
    };
  }, [meeting.found, meeting.status, meeting.valid, micEnabled, stage]);

  const enterLiveKitRoom = useCallback(
    async (result: JoinTokenResponse, nextParticipantToken: string | null) => {
      const { livekit } = result;

      if (!livekit.url || !livekit.token) {
        setErrorMessage(
          "La conexión de video no está disponible en este momento.",
        );
        setStage("prejoin");
        return;
      }

      stopStream(previewStreamRef.current);
      setPreviewStream(null);
      setActiveMeeting(result.meeting);
      setParticipantId(livekit.identity);
      setParticipantToken(nextParticipantToken);
      setErrorMessage(null);
      setNotice(null);
      setRoomMessage(null);
      setStage("room");
      setConnectionState("connecting");
      leavingRef.current = false;

      const nextRoom = new Room({
        adaptiveStream: true,
        dynacast: true,
      });
      connectingRoomRef.current = nextRoom;
      setRoom(nextRoom);

      try {
        await nextRoom.connect(livekit.url, livekit.token);
        await nextRoom.startAudio().catch(() => undefined);
        setConnectionState("connected");

        await publishInitialMedia(nextRoom, {
          camera: latestJoinInputRef.current.camera,
          microphone: latestJoinInputRef.current.microphone,
          onCameraBlocked: () => {
            setCameraEnabled(false);
            setMediaWarning((current) => ({
              ...current,
              camera:
                "No pudimos activar la cámara. Sigues dentro de la reunión.",
            }));
          },
          onMicrophoneBlocked: () => {
            setMicEnabled(false);
            setMediaWarning((current) => ({
              ...current,
              microphone:
                "No pudimos activar el micrófono. Sigues dentro de la reunión.",
            }));
          },
        });
        setRoomMediaVersion((value) => value + 1);
      } catch (error) {
        nextRoom.disconnect();
        setRoom(null);
        setConnectionState("error");
        setErrorMessage(userFacingError(error));
        setStage("prejoin");
      }
    },
    [],
  );

  useEffect(() => {
    if (!room) return undefined;

    const refreshMedia = () => setRoomMediaVersion((value) => value + 1);
    const handleReconnecting = () => {
      setConnectionState("reconnecting");
      setRoomMessage("Intentando reconectar la reunión...");
    };
    const handleReconnected = () => {
      setConnectionState("connected");
      setRoomMessage("Conexión restaurada.");
      window.setTimeout(() => setRoomMessage(null), 2200);
    };
    const handleConnectionState = (state: ConnectionState) => {
      setConnectionState(connectionLabel(state));
    };
    const handleParticipantDisconnected = (participant: Participant) => {
      refreshMedia();
      if (isHostIdentity(participant.identity, activeMeeting)) {
        setRoomMessage(
          "El host se desconectó. Te avisaremos si vuelve o finaliza la reunión.",
        );
      }
    };
    const handleDisconnected = () => {
      if (leavingRef.current) return;
      setConnectionState("disconnected");
      setRoomMessage(
        "La conexión se cerró. Puedes volver a entrar cuando quieras.",
      );
      setStage("prejoin");
      setNotice("Se interrumpió la conexión.");
      setRoom(null);
    };

    room.on(RoomEvent.ParticipantConnected, refreshMedia);
    room.on(RoomEvent.ParticipantDisconnected, handleParticipantDisconnected);
    room.on(RoomEvent.TrackSubscribed, refreshMedia);
    room.on(RoomEvent.TrackUnsubscribed, refreshMedia);
    room.on(RoomEvent.TrackMuted, refreshMedia);
    room.on(RoomEvent.TrackUnmuted, refreshMedia);
    room.on(RoomEvent.LocalTrackPublished, refreshMedia);
    room.on(RoomEvent.LocalTrackUnpublished, refreshMedia);
    room.on(RoomEvent.ParticipantNameChanged, refreshMedia);
    room.on(RoomEvent.ConnectionQualityChanged, refreshMedia);
    room.on(RoomEvent.ConnectionStateChanged, handleConnectionState);
    room.on(RoomEvent.Reconnecting, handleReconnecting);
    room.on(RoomEvent.Reconnected, handleReconnected);
    room.on(RoomEvent.Disconnected, handleDisconnected);
    refreshMedia();

    return () => {
      room.off(RoomEvent.ParticipantConnected, refreshMedia);
      room.off(
        RoomEvent.ParticipantDisconnected,
        handleParticipantDisconnected,
      );
      room.off(RoomEvent.TrackSubscribed, refreshMedia);
      room.off(RoomEvent.TrackUnsubscribed, refreshMedia);
      room.off(RoomEvent.TrackMuted, refreshMedia);
      room.off(RoomEvent.TrackUnmuted, refreshMedia);
      room.off(RoomEvent.LocalTrackPublished, refreshMedia);
      room.off(RoomEvent.LocalTrackUnpublished, refreshMedia);
      room.off(RoomEvent.ParticipantNameChanged, refreshMedia);
      room.off(RoomEvent.ConnectionQualityChanged, refreshMedia);
      room.off(RoomEvent.ConnectionStateChanged, handleConnectionState);
      room.off(RoomEvent.Reconnecting, handleReconnecting);
      room.off(RoomEvent.Reconnected, handleReconnected);
      room.off(RoomEvent.Disconnected, handleDisconnected);
    };
  }, [activeMeeting, room]);

  useEffect(() => {
    if (stage !== "waiting" || !waitingAccess) return undefined;

    let cancelled = false;
    let timeoutId: number | null = null;

    const poll = async () => {
      try {
        const result = await requestJoinToken({
          code: meeting.code,
          displayName: normalizedDisplayName(displayName),
          camera: latestJoinInputRef.current.camera,
          microphone: latestJoinInputRef.current.microphone,
          participantId: waitingAccess.participantId,
          participantToken: waitingAccess.participantToken,
        });
        if (cancelled) return;
        await enterLiveKitRoom(
          result,
          result.participantToken ?? waitingAccess.participantToken,
        );
      } catch (error) {
        if (cancelled) return;
        if (
          error instanceof GuestRoomApiError &&
          error.code === "WAITING_FOR_HOST"
        ) {
          timeoutId = window.setTimeout(poll, 3000);
          return;
        }
        setErrorMessage(userFacingError(error));
        setStage("prejoin");
      }
    };

    timeoutId = window.setTimeout(poll, 1200);

    return () => {
      cancelled = true;
      if (timeoutId) window.clearTimeout(timeoutId);
    };
  }, [displayName, enterLiveKitRoom, meeting.code, stage, waitingAccess]);

  useEffect(() => {
    if (stage !== "room") return undefined;

    let cancelled = false;
    const intervalId = window.setInterval(async () => {
      try {
        const result = await requestJson<ApiMeetingResponse>(
          `/api/meetings/${encodeURIComponent(meeting.code)}`,
        );
        if (cancelled) return;
        setActiveMeeting(result.meeting);
        if (result.meeting.status === "ENDED") {
          leavingRef.current = true;
          connectingRoomRef.current?.disconnect();
          room?.disconnect();
          setRoom(null);
          setConnectionState("disconnected");
          setRoomMessage(null);
          setStage("ended");
        }
      } catch {
        // Keep the call alive if a transient status refresh fails.
      }
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [meeting.code, room, stage]);

  useEffect(() => {
    return () => {
      connectingRoomRef.current?.disconnect();
      stopStream(previewStreamRef.current);
    };
  }, []);

  const tiles = useMemo(
    () =>
      room && activeMeeting
        ? buildLiveKitTiles(room, activeMeeting, roomMediaVersion)
        : [],
    [activeMeeting, room, roomMediaVersion],
  );
  const remoteAudioTracks = useMemo(
    () => (room ? collectRemoteAudioTracks(room) : []),
    [room, roomMediaVersion],
  );
  const canUseMeeting =
    meeting.valid && meeting.found && meeting.status !== "ENDED";
  const metadata = meetingMetadata(meeting);

  async function handleJoin() {
    const name = normalizedDisplayName(displayName);

    if (!name) {
      setErrorMessage("Ingresa tu nombre para entrar.");
      return;
    }

    setErrorMessage(null);
    setNotice(null);
    setStage("joining");

    try {
      const result = await requestJoinToken({
        code: meeting.code,
        displayName: name,
        camera: cameraEnabled,
        microphone: micEnabled,
      });
      await enterLiveKitRoom(result, result.participantToken ?? null);
    } catch (error) {
      if (
        error instanceof GuestRoomApiError &&
        error.code === "WAITING_ROOM_REQUIRED"
      ) {
        setStage("email");
        return;
      }
      setErrorMessage(userFacingError(error));
      setStage("prejoin");
    }
  }

  async function handleRequestAccess() {
    const name = normalizedDisplayName(displayName);

    if (!name) {
      setErrorMessage("Ingresa tu nombre para solicitar acceso.");
      return;
    }

    setErrorMessage(null);
    setStage("joining");

    try {
      const result = await requestJson<WaitingRoomResponse>(
        `/api/meetings/${encodeURIComponent(meeting.code)}/waiting-room`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            displayName: name,
            email: email.trim() || undefined,
            camera: cameraEnabled,
            microphone: micEnabled,
          }),
        },
      );
      setActiveMeeting(result.meeting);
      setWaitingAccess({
        participantId: result.participantId,
        participantToken: result.participantToken,
      });
      setParticipantId(result.participantId);
      setParticipantToken(result.participantToken);
      setStage("waiting");
    } catch (error) {
      if (
        error instanceof GuestRoomApiError &&
        error.code === "INVITE_EMAIL_REQUIRED"
      ) {
        setErrorMessage("Ingresa el correo con el que te invitaron.");
        setStage("email");
        return;
      }
      setErrorMessage(userFacingError(error));
      setStage("email");
    }
  }

  async function toggleRoomCamera() {
    if (!room || cameraBusy) return;
    const nextEnabled = !cameraEnabled;

    setCameraBusy(true);
    setErrorMessage(null);
    try {
      await room.localParticipant.setCameraEnabled(nextEnabled);
      setCameraEnabled(nextEnabled);
      await updateParticipantMedia({ camera: nextEnabled }).catch(
        () => undefined,
      );
      setRoomMediaVersion((value) => value + 1);
    } catch {
      setErrorMessage(
        nextEnabled
          ? "No pudimos activar la cámara. Revisa los permisos del navegador."
          : "No pudimos apagar la cámara.",
      );
    } finally {
      setCameraBusy(false);
    }
  }

  async function toggleRoomMic() {
    if (!room || micBusy) return;
    const nextEnabled = !micEnabled;

    setMicBusy(true);
    setErrorMessage(null);
    try {
      await room.localParticipant.setMicrophoneEnabled(nextEnabled);
      setMicEnabled(nextEnabled);
      await updateParticipantMedia({ microphone: nextEnabled }).catch(
        () => undefined,
      );
      setRoomMediaVersion((value) => value + 1);
    } catch {
      setErrorMessage(
        nextEnabled
          ? "No pudimos activar el micrófono. Revisa los permisos del navegador."
          : "No pudimos silenciar el micrófono.",
      );
    } finally {
      setMicBusy(false);
    }
  }

  async function updateParticipantMedia(input: {
    camera?: boolean;
    microphone?: boolean;
  }) {
    if (!participantId) return;

    await requestJson<ApiMeetingResponse>(
      `/api/meetings/${encodeURIComponent(meeting.code)}/participants/${encodeURIComponent(participantId)}/media`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...input,
          participantToken: participantToken ?? undefined,
        }),
      },
    ).then((result) => setActiveMeeting(result.meeting));
  }

  async function handleLeaveRoom() {
    leavingRef.current = true;
    connectingRoomRef.current?.disconnect();
    room?.disconnect();
    setRoom(null);
    setConnectionState("disconnected");
    setStage("prejoin");
    setNotice("Saliste de la reunión.");
    setRoomMessage(null);
    setWaitingAccess(null);

    if (!participantId) return;

    await requestJson<ApiMeetingResponse>(
      `/api/meetings/${encodeURIComponent(meeting.code)}/leave`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          participantId,
          participantToken: participantToken ?? undefined,
        }),
      },
    )
      .then((result) => setActiveMeeting(result.meeting))
      .catch(() => undefined);
  }

  async function handleLeaveWaitingRoom() {
    const waitingParticipantId = waitingAccess?.participantId;
    const waitingParticipantToken = waitingAccess?.participantToken;

    setWaitingAccess(null);
    setStage("prejoin");
    setNotice("Solicitud cancelada.");

    if (!waitingParticipantId) return;

    await requestJson<ApiMeetingResponse>(
      `/api/meetings/${encodeURIComponent(meeting.code)}/leave`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          participantId: waitingParticipantId,
          participantToken: waitingParticipantToken ?? undefined,
        }),
      },
    ).catch(() => undefined);
  }

  function openNativeApp() {
    if (!nativeUrl) return;
    window.location.href = nativeUrl;
  }

  if (!meeting.valid) {
    return (
      <GuestErrorScreen
        title="Enlace no válido"
        description="Revisa el enlace recibido o solicita un nuevo enlace al host."
      />
    );
  }

  if (!meeting.found) {
    return (
      <GuestErrorScreen
        title="No encontramos esta reunión"
        description="Puede que el enlace haya cambiado o que la reunión ya no exista."
      />
    );
  }

  if (meeting.status === "ENDED" || stage === "ended") {
    return (
      <GuestErrorScreen
        title="La reunión ya terminó"
        description="Pide al host un nuevo enlace si necesitas volver a entrar."
      />
    );
  }

  if (stage === "waiting") {
    return (
      <main
        className="guest-room-shell waiting"
        data-testid="web-guest-waiting"
      >
        <section className="guest-waiting-panel">
          <span className="meeting-launch-mark">SM</span>
          <div>
            <p className="guest-room-kicker">Shape Meet</p>
            <h1>Esperando a que el host te admita</h1>
            <p>{meeting.title}</p>
          </div>
          <div className="guest-waiting-pulse" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <button
            className="meeting-launch-secondary subtle"
            type="button"
            onClick={() => void handleLeaveWaitingRoom()}
          >
            Cancelar solicitud
          </button>
        </section>
      </main>
    );
  }

  if (stage === "room") {
    return (
      <main
        className="guest-room-call"
        data-connection-state={connectionState}
        data-testid="web-guest-room"
      >
        <header className="guest-call-header">
          <div>
            <p className="guest-room-kicker">Shape Meet</p>
            <h1>{activeMeeting?.title ?? meeting.title}</h1>
          </div>
          <span className={`guest-connection-chip ${connectionState}`}>
            {connectionStatusLabel(connectionState)}
          </span>
        </header>

        {(roomMessage || errorMessage) && (
          <div
            className={
              errorMessage ? "guest-room-alert danger" : "guest-room-alert"
            }
          >
            <AlertCircle />
            <span>{errorMessage ?? roomMessage}</span>
          </div>
        )}

        <section
          className={`guest-video-grid count-${Math.max(tiles.length, 1)}`}
        >
          {tiles.length > 0 ? (
            tiles.map((tile) => <VideoTile key={tile.id} tile={tile} />)
          ) : (
            <div className="guest-empty-stage">
              <Loader2 className="spin" />
              <span>Preparando la sala...</span>
            </div>
          )}
        </section>

        <RemoteAudioTracks tracks={remoteAudioTracks} />

        <div className="guest-call-controls" aria-label="Controles de reunión">
          <button
            className={
              micEnabled ? "guest-control-button" : "guest-control-button off"
            }
            type="button"
            onClick={() => void toggleRoomMic()}
            aria-label={
              micEnabled ? "Silenciar micrófono" : "Activar micrófono"
            }
            disabled={micBusy}
          >
            {micBusy ? (
              <Loader2 className="spin" />
            ) : micEnabled ? (
              <Mic />
            ) : (
              <MicOff />
            )}
            <span>{micEnabled ? "Silenciar" : "Activar audio"}</span>
          </button>
          <button
            className={
              cameraEnabled
                ? "guest-control-button"
                : "guest-control-button off"
            }
            type="button"
            onClick={() => void toggleRoomCamera()}
            aria-label={cameraEnabled ? "Apagar cámara" : "Activar cámara"}
            disabled={cameraBusy}
          >
            {cameraBusy ? (
              <Loader2 className="spin" />
            ) : cameraEnabled ? (
              <Camera />
            ) : (
              <CameraOff />
            )}
            <span>{cameraEnabled ? "Apagar cámara" : "Activar cámara"}</span>
          </button>
          <button
            className="guest-control-button leave"
            type="button"
            onClick={() => void handleLeaveRoom()}
          >
            <PhoneOff />
            <span>Salir</span>
          </button>
        </div>
      </main>
    );
  }

  return (
    <main
      className="meeting-launch-shell guest-room-shell"
      data-testid="web-guest-prejoin"
    >
      <section className="meeting-launch-panel guest-prejoin-panel">
        <div className="guest-prejoin-copy">
          <span className="meeting-launch-mark">SM</span>
          <p className="guest-room-kicker">Shape Meet</p>
          <h1>{meeting.title}</h1>
          <p>{metadata}</p>
          <div className="meeting-launch-code">
            <span>{meeting.code}</span>
          </div>
        </div>

        <div className="guest-preview-panel">
          <div className="guest-video-preview">
            {previewStream && cameraEnabled ? (
              <video muted playsInline ref={previewVideoRef} />
            ) : (
              <div className="guest-preview-placeholder">
                <CameraOff />
                <span>Cámara apagada</span>
              </div>
            )}
          </div>
          <div className="guest-media-toggles">
            <button
              className={cameraEnabled ? "guest-toggle active" : "guest-toggle"}
              type="button"
              onClick={() => setCameraEnabled((value) => !value)}
              aria-pressed={cameraEnabled}
            >
              {cameraEnabled ? <Camera /> : <CameraOff />}
              <span>Cámara</span>
            </button>
            <button
              className={micEnabled ? "guest-toggle active" : "guest-toggle"}
              type="button"
              onClick={() => setMicEnabled((value) => !value)}
              aria-pressed={micEnabled}
            >
              {micEnabled ? <Mic /> : <MicOff />}
              <span>Micrófono</span>
            </button>
          </div>
        </div>

        <form
          className="guest-join-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (stage === "email") void handleRequestAccess();
            else void handleJoin();
          }}
        >
          {notice ? (
            <div className="guest-room-alert success">{notice}</div>
          ) : null}
          {permissionWarning(mediaWarning) ? (
            <div className="guest-room-alert">
              <AlertCircle />
              <span>{permissionWarning(mediaWarning)}</span>
            </div>
          ) : null}
          {errorMessage ? (
            <div className="guest-room-alert danger">
              <AlertCircle />
              <span>{errorMessage}</span>
            </div>
          ) : null}

          <label className="field guest-field">
            <span>Nombre</span>
            <div>
              <input
                autoComplete="name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Tu nombre"
                disabled={!canUseMeeting || stage === "joining"}
              />
            </div>
          </label>

          {stage === "email" ? (
            <label className="field guest-field">
              <span>Correo de invitación</span>
              <div>
                <input
                  autoComplete="email"
                  inputMode="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="correo@empresa.com"
                />
              </div>
            </label>
          ) : null}

          <button
            className="meeting-launch-primary"
            type="submit"
            disabled={!canUseMeeting || stage === "joining"}
          >
            {stage === "joining" ? (
              <>
                <Loader2 className="spin" />
                Conectando
              </>
            ) : stage === "email" ? (
              "Solicitar acceso"
            ) : (
              "Entrar a la reunión"
            )}
          </button>

          {nativeUrl ? (
            <button
              className="meeting-launch-secondary host-open-button"
              type="button"
              onClick={openNativeApp}
            >
              ¿Eres el host? Abrir en la app de escritorio
            </button>
          ) : null}
        </form>
      </section>
    </main>
  );
}

function VideoTile({ tile }: { tile: CallTile }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const element = videoRef.current;
    if (!element || !tile.videoTrack || !tile.cameraOn) return;

    tile.videoTrack.attach(element);
    void element.play().catch(() => undefined);

    return () => {
      tile.videoTrack?.detach(element);
    };
  }, [tile.cameraOn, tile.videoTrack]);

  return (
    <article
      className={tile.isLocal ? "guest-video-tile local" : "guest-video-tile"}
    >
      {tile.videoTrack && tile.cameraOn ? (
        <video
          className="guest-tile-video"
          muted={tile.isLocal}
          playsInline
          ref={videoRef}
        />
      ) : (
        <div className="guest-tile-avatar">{initials(tile.label)}</div>
      )}
      <div className="guest-tile-footer">
        <div>
          <strong>{tile.isLocal ? `${tile.label} (tú)` : tile.label}</strong>
          <span>{tile.role === "host" ? "Host" : "Invitado"}</span>
        </div>
        <span className={tile.micOn ? "guest-mic-chip" : "guest-mic-chip off"}>
          {tile.micOn ? <Mic /> : <MicOff />}
        </span>
      </div>
    </article>
  );
}

function RemoteAudioTracks({
  tracks,
}: {
  tracks: Array<{
    id: string;
    track: NonNullable<TrackPublication["audioTrack"]>;
  }>;
}) {
  return (
    <div className="remote-audio-layer" aria-hidden="true">
      {tracks.map((item) => (
        <RemoteAudioTrack key={item.id} track={item.track} />
      ))}
    </div>
  );
}

function RemoteAudioTrack({
  track,
}: {
  track: NonNullable<TrackPublication["audioTrack"]>;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const element = audioRef.current;
    if (!element) return;

    track.attach(element);
    void element.play().catch(() => undefined);

    return () => {
      track.detach(element);
    };
  }, [track]);

  return <audio ref={audioRef} autoPlay />;
}

function GuestErrorScreen({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <main className="guest-room-shell error">
      <section className="guest-error-panel">
        <span className="meeting-launch-mark">SM</span>
        <div>
          <p className="guest-room-kicker">Shape Meet</p>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        <div className="meeting-launch-actions">
          <button
            className="meeting-launch-primary"
            type="button"
            onClick={() => window.location.reload()}
          >
            <RefreshCw />
            Reintentar
          </button>
          <a className="meeting-launch-secondary" href="/">
            Ir al inicio
          </a>
        </div>
      </section>
    </main>
  );
}

async function publishInitialMedia(
  room: Room,
  input: {
    camera: boolean;
    microphone: boolean;
    onCameraBlocked: () => void;
    onMicrophoneBlocked: () => void;
  },
) {
  if (input.camera) {
    await room.localParticipant
      .setCameraEnabled(true)
      .catch(() => input.onCameraBlocked());
  }

  if (input.microphone) {
    await room.localParticipant
      .setMicrophoneEnabled(true)
      .catch(() => input.onMicrophoneBlocked());
  }
}

async function requestJoinToken(input: {
  code: string;
  displayName: string;
  camera: boolean;
  microphone: boolean;
  participantId?: string | null;
  participantToken?: string | null;
}) {
  return requestJson<JoinTokenResponse>(
    `/api/meetings/${encodeURIComponent(input.code)}/join-token`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: input.displayName,
        camera: input.camera,
        microphone: input.microphone,
        participantId: input.participantId ?? undefined,
        participantToken: input.participantToken ?? undefined,
      }),
    },
  );
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const text = await response.text();
  let data: Record<string, unknown> = {};

  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    data = {};
  }

  if (!response.ok) {
    const message =
      typeof data.error === "string"
        ? data.error
        : "No se pudo completar la solicitud.";
    const code = typeof data.code === "string" ? data.code : undefined;
    throw new GuestRoomApiError(message, response.status, code);
  }

  return data as T;
}

function buildLiveKitTiles(
  room: Room,
  meeting: GuestMeeting,
  _version: number,
) {
  const meetingByParticipantId = new Map(
    meeting.participants.map((participant) => [participant.id, participant]),
  );
  const participants: Array<{ participant: Participant; isLocal: boolean }> = [
    { participant: room.localParticipant, isLocal: true },
    ...Array.from(room.remoteParticipants.values()).map((participant) => ({
      participant,
      isLocal: false,
    })),
  ];

  const tiles = participants.map(({ participant, isLocal }) =>
    tileFromParticipant(participant, meetingByParticipantId, isLocal),
  );
  const knownIdentities = new Set(tiles.map((tile) => tile.identity));

  meeting.participants
    .filter(
      (participant) =>
        participant.joinedAt &&
        !participant.leftAt &&
        !knownIdentities.has(participant.id),
    )
    .forEach((participant) => {
      tiles.push({
        id: participant.id,
        identity: participant.id,
        label: participant.displayName,
        role: participant.role,
        isLocal: participant.id === room.localParticipant.identity,
        cameraOn: participant.camera === "on",
        micOn: participant.mic === "on",
      });
    });

  return tiles.sort((left, right) => {
    if (left.isLocal !== right.isLocal) return left.isLocal ? 1 : -1;
    if (left.role !== right.role) return left.role === "host" ? -1 : 1;
    return left.label.localeCompare(right.label);
  });
}

function tileFromParticipant(
  participant: Participant,
  meetingByParticipantId: Map<string, MeetingParticipant>,
  isLocal: boolean,
): CallTile {
  const meetingParticipant = meetingByParticipantId.get(participant.identity);
  const videoPublication =
    participant.getTrackPublication(Track.Source.Camera) ??
    firstPublication(participant.videoTrackPublications);
  const audioPublication =
    participant.getTrackPublication(Track.Source.Microphone) ??
    firstPublication(participant.audioTrackPublications);
  const videoTrack = videoPublication?.videoTrack;
  const audioTrack = audioPublication?.audioTrack;

  return {
    id: participant.sid || participant.identity,
    identity: participant.identity,
    label:
      participant.name ||
      meetingParticipant?.displayName ||
      (isLocal ? "Tú" : "Invitado"),
    role: meetingParticipant?.role ?? "guest",
    isLocal,
    cameraOn: Boolean(videoTrack && !videoPublication?.isMuted),
    micOn: Boolean(audioTrack && !audioPublication?.isMuted),
    videoTrack,
  };
}

function collectRemoteAudioTracks(room: Room) {
  return Array.from(room.remoteParticipants.values()).flatMap((participant) =>
    Array.from(participant.audioTrackPublications.values())
      .filter((publication) => publication.audioTrack && !publication.isMuted)
      .map((publication) => ({
        id: `${participant.identity}:${publication.trackSid || publication.trackName}`,
        track: publication.audioTrack!,
      })),
  );
}

function firstPublication(publications: Map<string, TrackPublication>) {
  return (
    Array.from(publications.values()).find(
      (publication) => publication.videoTrack || publication.audioTrack,
    ) ?? Array.from(publications.values())[0]
  );
}

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

function normalizedDisplayName(value: string) {
  const name = value.trim();
  return name.length >= 2 ? name : "";
}

function permissionWarning(warning: MediaWarning) {
  return [warning.camera, warning.microphone].filter(Boolean).join(" ");
}

function userFacingError(error: unknown) {
  if (error instanceof GuestRoomApiError) {
    if (error.code === "INVITE_REQUIRED")
      return "Este correo no tiene acceso a la reunión.";
    if (error.code === "PARTICIPANT_TOKEN_REQUIRED")
      return "Tu solicitud de acceso ya no está activa.";
    if (error.code === "WAITING_ROOM_EXPIRED")
      return "Tu solicitud ya no está activa. Solicita acceso de nuevo.";
    if (error.code === "MEETING_ENDED") return "La reunión ya terminó.";
    if (error.status === 404) return "No encontramos esta reunión.";
    if (error.status === 409)
      return error.message || "La reunión no está disponible en este momento.";
    if (error.status === 403)
      return error.message || "No tienes acceso a esta reunión.";
    return error.message;
  }

  if (error instanceof Error) return error.message;
  return "No se pudo conectar con la reunión.";
}

function isHostIdentity(identity: string, meeting: GuestMeeting | null) {
  return (
    meeting?.participants.some(
      (participant) =>
        participant.id === identity && participant.role === "host",
    ) ?? false
  );
}

function connectionLabel(state: ConnectionState): ConnectionLabel {
  if (state === ConnectionState.Connected) return "connected";
  if (
    state === ConnectionState.Reconnecting ||
    state === ConnectionState.SignalReconnecting
  )
    return "reconnecting";
  if (state === ConnectionState.Disconnected) return "disconnected";
  return "connecting";
}

function connectionStatusLabel(state: ConnectionLabel) {
  if (state === "connected") return "Conectado";
  if (state === "reconnecting") return "Reconectando";
  if (state === "connecting") return "Conectando";
  if (state === "error") return "Sin conexión";
  return "Desconectado";
}

function meetingMetadata(meeting: PublicMeeting) {
  const pieces = [
    meeting.startsAt ? formatMeetingTime(meeting.startsAt) : null,
    meeting.maxParticipants
      ? `Hasta ${meeting.maxParticipants} participantes`
      : null,
    meeting.access === "INVITE_ONLY"
      ? "Acceso con invitación"
      : "Enlace público",
    meeting.status ? meetingStatusLabel(meeting.status) : null,
  ].filter(Boolean);

  return pieces.join(" · ") || "Reunión disponible";
}

function formatMeetingTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat("es-CO", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Bogota",
  }).format(date);
}

function meetingStatusLabel(status: MeetingStatus) {
  if (status === "SCHEDULED") return "Agendada";
  if (status === "WAITING") return "Sala abierta";
  if (status === "LIVE") return "En vivo";
  return "Finalizada";
}

function initials(value: string) {
  const letters = value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((piece) => piece[0]?.toUpperCase())
    .join("");

  return letters || "SM";
}
