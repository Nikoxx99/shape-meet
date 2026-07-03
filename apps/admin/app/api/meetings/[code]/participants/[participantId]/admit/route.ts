import { NextResponse } from "next/server";
import { getAuthenticatedHost } from "../../../../../../../lib/auth";
import { serializeMeeting } from "../../../../../../../lib/formatters";
import { prisma } from "../../../../../../../lib/prisma";
import { apiErrorResponse } from "../../../../../../../lib/api-errors";

export async function POST(_request: Request, context: { params: Promise<{ code: string; participantId: string }> }) {
  try {
    const { code, participantId } = await context.params;
    const session = await getAuthenticatedHost(_request);

    if (!session) {
      return NextResponse.json({ error: "Sesión inválida." }, { status: 401 });
    }

    const normalizedCode = decodeURIComponent(code).trim().toUpperCase();
    const meeting = await prisma.meeting.findUnique({
      where: { code: normalizedCode },
      include: { participants: true, invites: true }
    });

    if (!meeting) {
      return NextResponse.json({ error: "Reunión no encontrada." }, { status: 404 });
    }

    const canAdmit = session.user.id === meeting.hostId || session.user.rank === "ADMIN";

    if (!canAdmit) {
      return NextResponse.json({ error: "Solo el host puede admitir participantes." }, { status: 403 });
    }

    const participant = meeting.participants.find((item) => item.id === participantId && item.role !== "host");

    if (!participant || participant.leftAt) {
      return NextResponse.json({ error: "Participante no encontrado." }, { status: 404 });
    }

    const activeParticipants = meeting.participants.filter((item) => item.joinedAt && !item.leftAt);

    if (activeParticipants.length >= meeting.maxParticipants) {
      return NextResponse.json({ error: "La reunión ya está llena." }, { status: 409 });
    }

    await prisma.meetingParticipant.update({
      where: { id: participant.id },
      data: { admittedAt: new Date() }
    });

    const updatedMeeting = await prisma.meeting.update({
      where: { id: meeting.id },
      data: { status: meeting.status === "SCHEDULED" ? "WAITING" : meeting.status },
      include: { participants: true, invites: true }
    });

    await prisma.auditLog.create({
      data: {
        actorId: session.user.id,
        action: "MEETING_PARTICIPANT_ADMITTED",
        targetId: meeting.id,
        metadata: {
          code: meeting.code,
          participantId: participant.id
        }
      }
    });

    return NextResponse.json({ meeting: serializeMeeting(updatedMeeting) });
  } catch (error) {
    return apiErrorResponse(error, { fallbackMessage: "No se pudo admitir al participante." });
  }
}
