import { NextResponse } from "next/server";
import { AccessToken } from "livekit-server-sdk";
import { z } from "zod";
import {
  getAuthenticatedHost,
  participantTokenMatches,
  signMeetingParticipantToken,
} from "../../../../../lib/auth";
import { serializeMeeting } from "../../../../../lib/formatters";
import { prisma } from "../../../../../lib/prisma";
import { apiErrorResponse } from "../../../../../lib/api-errors";

const joinSchema = z.object({
  displayName: z.string().min(2).max(80),
  camera: z.boolean().default(true),
  microphone: z.boolean().default(true),
  participantId: z.string().min(6).optional(),
  participantToken: z.string().min(20).optional(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ code: string }> },
) {
  try {
    const { code } = await context.params;
    const input = joinSchema.parse(await request.json());
    const session = await getAuthenticatedHost(request).catch(() => null);
    const normalizedCode = decodeURIComponent(code).trim().toUpperCase();

    const meeting = await prisma.meeting.findUnique({
      where: { code: normalizedCode },
      include: { participants: true, invites: true },
    });

    if (!meeting) {
      return NextResponse.json(
        { error: "Reunión no encontrada." },
        { status: 404 },
      );
    }

    if (meeting.status === "ENDED") {
      return NextResponse.json(
        { error: "La reunión ya terminó.", code: "MEETING_ENDED" },
        { status: 409 },
      );
    }

    const isHost = Boolean(
      session &&
      (session.user.id === meeting.hostId || session.user.rank === "ADMIN"),
    );
    const participantCount = meeting.participants.filter(
      (participant) => participant.joinedAt && !participant.leftAt,
    ).length;

    if (!isHost && participantCount >= meeting.maxParticipants) {
      return NextResponse.json(
        { error: "La reunión ya está llena." },
        { status: 409 },
      );
    }

    const existingParticipant = isHost
      ? await prisma.meetingParticipant.findFirst({
          where: {
            meetingId: meeting.id,
            userId: session?.user.id,
            role: "host",
          },
        })
      : null;

    const pendingParticipant =
      !isHost && input.participantId
        ? meeting.participants.find(
            (participant) =>
              participant.id === input.participantId &&
              participant.role !== "host",
          )
        : null;

    if (!isHost && !pendingParticipant && meeting.access === "INVITE_ONLY") {
      return NextResponse.json(
        {
          error: "Debes solicitar acceso desde la sala de espera.",
          code: "WAITING_ROOM_REQUIRED",
        },
        { status: 409 },
      );
    }

    if (
      !isHost &&
      pendingParticipant &&
      !(await participantTokenMatches(input.participantToken, {
        meetingId: meeting.id,
        meetingCode: meeting.code,
        participantId: pendingParticipant.id,
      }))
    ) {
      return NextResponse.json(
        {
          error: "Sesión de invitado requerida.",
          code: "PARTICIPANT_TOKEN_REQUIRED",
        },
        { status: 401 },
      );
    }

    if (
      !isHost &&
      meeting.access === "INVITE_ONLY" &&
      !pendingParticipant?.admittedAt
    ) {
      return NextResponse.json(
        { error: "El host aún no te ha admitido.", code: "WAITING_FOR_HOST" },
        { status: 409 },
      );
    }

    if (pendingParticipant?.leftAt) {
      return NextResponse.json(
        {
          error: "Esta solicitud ya no está activa.",
          code: "WAITING_ROOM_EXPIRED",
        },
        { status: 409 },
      );
    }

    const participant = isHost
      ? existingParticipant
        ? await prisma.meetingParticipant.update({
            where: { id: existingParticipant.id },
            data: {
              displayName: input.displayName,
              cameraEnabled: input.camera,
              microphoneEnabled: input.microphone,
              admittedAt: new Date(),
              joinedAt: new Date(),
              leftAt: null,
            },
          })
        : await prisma.meetingParticipant.create({
            data: {
              meetingId: meeting.id,
              displayName: input.displayName,
              userId: session?.user.id,
              role: "host",
              cameraEnabled: input.camera,
              microphoneEnabled: input.microphone,
              admittedAt: new Date(),
              joinedAt: new Date(),
            },
          })
      : pendingParticipant
        ? await prisma.meetingParticipant.update({
            where: { id: pendingParticipant!.id },
            data: {
              displayName: input.displayName,
              cameraEnabled: input.camera,
              microphoneEnabled: input.microphone,
              admittedAt: pendingParticipant.admittedAt ?? new Date(),
              joinedAt: new Date(),
              leftAt: null,
            },
          })
        : await prisma.meetingParticipant.create({
            data: {
              meetingId: meeting.id,
              displayName: input.displayName,
              role: "guest",
              cameraEnabled: input.camera,
              microphoneEnabled: input.microphone,
              admittedAt: new Date(),
              joinedAt: new Date(),
            },
          });

    const updatedMeeting = await prisma.meeting.update({
      where: { id: meeting.id },
      data: { status: "LIVE" },
      include: { participants: true, invites: true },
    });

    const livekit = await buildLiveKitToken({
      room: meeting.code,
      identity: participant.id,
      name: input.displayName,
      canPublish: true,
      canSubscribe: true,
    });

    const participantToken = isHost
      ? null
      : await signMeetingParticipantToken({
          meetingId: meeting.id,
          meetingCode: meeting.code,
          participantId: participant.id,
        });

    return NextResponse.json({
      meeting: serializeMeeting(updatedMeeting, {
        includeInvites: isHost,
        includeParticipantEmails: isHost,
      }),
      livekit,
      participantToken,
    });
  } catch (error) {
    return apiErrorResponse(error, {
      fallbackMessage: "No se pudo emitir acceso a la reunión.",
    });
  }
}

async function buildLiveKitToken(input: {
  room: string;
  identity: string;
  name: string;
  canPublish: boolean;
  canSubscribe: boolean;
}) {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const url = process.env.LIVEKIT_URL ?? null;

  if (!apiKey || !apiSecret || !url) {
    return {
      url,
      token: null,
      room: input.room,
      identity: input.identity,
      warning: "LiveKit no está configurado en este entorno.",
    };
  }

  const token = new AccessToken(apiKey, apiSecret, {
    identity: input.identity,
    name: input.name,
  });

  token.addGrant({
    room: input.room,
    roomJoin: true,
    canPublish: input.canPublish,
    canSubscribe: input.canSubscribe,
  });

  return {
    url,
    token: await token.toJwt(),
    room: input.room,
    identity: input.identity,
  };
}
