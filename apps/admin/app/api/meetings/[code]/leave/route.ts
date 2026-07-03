import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthenticatedHost } from "../../../../../lib/auth";
import { serializeMeeting } from "../../../../../lib/formatters";
import { prisma } from "../../../../../lib/prisma";
import { apiErrorResponse } from "../../../../../lib/api-errors";

const leaveSchema = z.object({
  participantId: z.string().min(6)
});

export async function POST(request: Request, context: { params: Promise<{ code: string }> }) {
  try {
    const { code } = await context.params;
    const input = leaveSchema.parse(await request.json());
    const session = await getAuthenticatedHost(request).catch(() => null);
    const normalizedCode = decodeURIComponent(code).trim().toUpperCase();

    const meeting = await prisma.meeting.findUnique({
      where: { code: normalizedCode },
      include: { participants: true, invites: true }
    });

    if (!meeting) {
      return NextResponse.json({ error: "Reunión no encontrada." }, { status: 404 });
    }

    const participant = meeting.participants.find((item) => item.id === input.participantId);

    if (!participant) {
      return NextResponse.json({ error: "Participante no encontrado." }, { status: 404 });
    }

    const canLeaveAuthenticatedParticipant =
      !participant.userId || participant.userId === session?.user.id || session?.user.rank === "ADMIN";

    if (!canLeaveAuthenticatedParticipant) {
      return NextResponse.json({ error: "No puedes cerrar esta sesión." }, { status: 403 });
    }

    await prisma.meetingParticipant.update({
      where: { id: participant.id },
      data: { leftAt: new Date() }
    });

    const activeParticipants = await prisma.meetingParticipant.count({
      where: {
        meetingId: meeting.id,
        joinedAt: { not: null },
        leftAt: null
      }
    });

    const waitingParticipants = await prisma.meetingParticipant.count({
      where: {
        meetingId: meeting.id,
        role: { not: "host" },
        joinedAt: null,
        leftAt: null
      }
    });

    const nextStatus =
      meeting.status === "ENDED" ? "ENDED" : activeParticipants > 0 ? "LIVE" : waitingParticipants > 0 ? "WAITING" : "SCHEDULED";
    const updatedMeeting = await prisma.meeting.update({
      where: { id: meeting.id },
      data: { status: nextStatus },
      include: { participants: true, invites: true }
    });

    await prisma.auditLog.create({
      data: {
        actorId: session?.user.id,
        action: "MEETING_PARTICIPANT_LEFT",
        targetId: meeting.id,
        metadata: {
          code: meeting.code,
          participantId: participant.id,
          participantRole: participant.role
        }
      }
    });

    const canSeePrivateMeetingData = Boolean(session && (session.user.id === meeting.hostId || session.user.rank === "ADMIN"));

    return NextResponse.json({
      meeting: serializeMeeting(updatedMeeting, {
        includeInvites: canSeePrivateMeetingData,
        includeParticipantEmails: canSeePrivateMeetingData
      })
    });
  } catch (error) {
    return apiErrorResponse(error, { fallbackMessage: "No se pudo registrar la salida de la reunión." });
  }
}
