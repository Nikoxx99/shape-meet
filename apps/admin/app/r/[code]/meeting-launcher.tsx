"use client";

import { useEffect, useState } from "react";

type PublicMeeting = {
  code: string;
  title: string;
  startsAt: string | null;
  status: "SCHEDULED" | "WAITING" | "LIVE" | "ENDED" | null;
  maxParticipants: number | null;
  found: boolean;
  valid: boolean;
};

export function MeetingLauncher({
  meeting,
  nativeUrl,
}: {
  meeting: PublicMeeting;
  nativeUrl: string | null;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!nativeUrl) return undefined;

    const timeout = window.setTimeout(() => {
      window.location.href = nativeUrl;
    }, 450);

    return () => window.clearTimeout(timeout);
  }, [nativeUrl]);

  async function copyCode() {
    await navigator.clipboard?.writeText(meeting.code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <main className="meeting-launch-shell">
      <section className="meeting-launch-panel">
        <span className="meeting-launch-mark">SM</span>
        <div className="meeting-launch-copy">
          <span className="meeting-launch-kicker">Shape Meet</span>
          <h1>{meeting.valid ? meeting.title : "Enlace no válido"}</h1>
          <p>
            {meeting.valid
              ? meetingMetadata(meeting)
              : "Revisa el enlace recibido o pega el código en la app."}
          </p>
        </div>
        {meeting.valid ? (
          <div className="meeting-launch-code">
            <span>{meeting.code}</span>
          </div>
        ) : null}
        <div className="meeting-launch-actions">
          {nativeUrl ? (
            <a className="meeting-launch-primary" href={nativeUrl}>
              Abrir app
            </a>
          ) : null}
          {meeting.valid ? (
            <button className="meeting-launch-secondary" type="button" onClick={() => void copyCode()}>
              {copied ? "Copiado" : "Copiar código"}
            </button>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function meetingMetadata(meeting: PublicMeeting) {
  const pieces = [
    meeting.startsAt ? formatMeetingTime(meeting.startsAt) : null,
    meeting.maxParticipants ? `Hasta ${meeting.maxParticipants} participantes` : null,
    meeting.found && meeting.status ? meetingStatusLabel(meeting.status) : null,
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

function meetingStatusLabel(status: NonNullable<PublicMeeting["status"]>) {
  if (status === "SCHEDULED") return "Agendada";
  if (status === "WAITING") return "Sala abierta";
  if (status === "LIVE") return "En vivo";
  return "Finalizada";
}
