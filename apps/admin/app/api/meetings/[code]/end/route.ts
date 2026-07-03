import { NextResponse } from "next/server";
import { getAuthenticatedHost } from "../../../../../lib/auth";
import { serializeMeeting } from "../../../../../lib/formatters";
import { prisma } from "../../../../../lib/prisma";
import { apiErrorResponse } from "../../../../../lib/api-errors";

export async function POST(request: Request, context: { params: Promise<{ code: string }> }) {
  try {
    const { code } = await context.params;
    const session = await getAuthenticatedHost(request);

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

    const canEnd = session.user.id === meeting.hostId || session.user.rank === "ADMIN";

    if (!canEnd) {
      return NextResponse.json({ error: "Solo el host puede finalizar la reunión." }, { status: 403 });
    }

    const endedAt = new Date();

    await prisma.meetingParticipant.updateMany({
      where: {
        meetingId: meeting.id,
        joinedAt: { not: null },
        leftAt: null
      },
      data: { leftAt: endedAt }
    });

    const updatedMeeting = await prisma.meeting.update({
      where: { id: meeting.id },
      data: { status: "ENDED" },
      include: { participants: true, invites: true }
    });

    await prisma.auditLog.create({
      data: {
        actorId: session.user.id,
        action: "MEETING_ENDED",
        targetId: meeting.id,
        metadata: {
          code: meeting.code,
          endedAt: endedAt.toISOString()
        }
      }
    });

    return NextResponse.json({ meeting: serializeMeeting(updatedMeeting) });
  } catch (error) {
    return apiErrorResponse(error, { fallbackMessage: "No se pudo finalizar la reunión." });
  }
}
