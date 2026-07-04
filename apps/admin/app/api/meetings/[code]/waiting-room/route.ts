import { NextResponse } from "next/server";
import { z } from "zod";
import { signMeetingParticipantToken } from "../../../../../lib/auth";
import { serializeMeeting } from "../../../../../lib/formatters";
import { prisma } from "../../../../../lib/prisma";
import { apiErrorResponse } from "../../../../../lib/api-errors";

const waitingRoomSchema = z.object({
  displayName: z.string().min(2).max(80),
  email: z.string().email().optional().or(z.literal("")),
  camera: z.boolean().default(true),
  microphone: z.boolean().default(true)
});

export async function POST(request: Request, context: { params: Promise<{ code: string }> }) {
  try {
    const { code } = await context.params;
    const input = waitingRoomSchema.parse(await request.json());
    const normalizedCode = decodeURIComponent(code).trim().toUpperCase();

    const meeting = await prisma.meeting.findUnique({
      where: { code: normalizedCode },
      include: { participants: true, invites: true }
    });

    if (!meeting) {
      return NextResponse.json({ error: "Reunión no encontrada." }, { status: 404 });
    }

    if (meeting.status === "ENDED") {
      return NextResponse.json({ error: "La reunión ya terminó." }, { status: 409 });
    }

    const activeParticipants = meeting.participants.filter((participant) => participant.joinedAt && !participant.leftAt);

    if (activeParticipants.length >= meeting.maxParticipants) {
      return NextResponse.json({ error: "La reunión ya está llena." }, { status: 409 });
    }

    const email = normalizeEmail(input.email);

    if (meeting.access === "INVITE_ONLY") {
      if (!email) {
        return NextResponse.json(
          { error: "Ingresa el correo invitado.", code: "INVITE_EMAIL_REQUIRED" },
          { status: 403 }
        );
      }

      const invitedEmails = new Set(meeting.invites.map((invite) => invite.email.trim().toLowerCase()));

      if (!invitedEmails.has(email)) {
        return NextResponse.json(
          { error: "Este correo no está en la lista de invitados.", code: "INVITE_REQUIRED" },
          { status: 403 }
        );
      }
    }

    const existingParticipant = meeting.participants.find(
      (participant) =>
        participant.role !== "host" &&
        !participant.leftAt &&
        ((email && participant.email === email) || participant.displayName.trim().toLowerCase() === input.displayName.trim().toLowerCase())
    );

    const participant = existingParticipant
      ? await prisma.meetingParticipant.update({
          where: { id: existingParticipant.id },
          data: {
            displayName: input.displayName,
            email,
            cameraEnabled: input.camera,
            microphoneEnabled: input.microphone,
            admittedAt: null,
            joinedAt: null
          }
        })
      : await prisma.meetingParticipant.create({
          data: {
            meetingId: meeting.id,
            displayName: input.displayName,
            email,
            role: "guest",
            cameraEnabled: input.camera,
            microphoneEnabled: input.microphone
          }
        });

    const updatedMeeting = await prisma.meeting.update({
      where: { id: meeting.id },
      data: { status: meeting.status === "SCHEDULED" ? "WAITING" : meeting.status },
      include: { participants: true, invites: true }
    });

    await prisma.auditLog.create({
      data: {
        action: "MEETING_ACCESS_REQUESTED",
        targetId: meeting.id,
        metadata: {
          code: meeting.code,
          participantId: participant.id,
          email,
          camera: input.camera,
          microphone: input.microphone
        }
      }
    });

    return NextResponse.json({
      participantId: participant.id,
      participantToken: await signMeetingParticipantToken({
        meetingId: meeting.id,
        meetingCode: meeting.code,
        participantId: participant.id
      }),
      meeting: serializeMeeting(updatedMeeting, {
        includeInvites: false,
        includeParticipantEmails: false
      })
    });
  } catch (error) {
    return apiErrorResponse(error, { fallbackMessage: "No se pudo solicitar acceso a la reunión." });
  }
}

function normalizeEmail(email: string | undefined) {
  const normalized = email?.trim().toLowerCase();
  return normalized || null;
}
