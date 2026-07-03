import { NextResponse } from "next/server";
import { getAuthenticatedHost } from "../../../../lib/auth";
import { serializeMeeting } from "../../../../lib/formatters";
import { prisma } from "../../../../lib/prisma";
import { apiErrorResponse } from "../../../../lib/api-errors";

export async function GET(request: Request, context: { params: Promise<{ code: string }> }) {
  try {
    const { code } = await context.params;
    const session = await getAuthenticatedHost(request).catch(() => null);
    const meeting = await prisma.meeting.findUnique({
      where: { code: normalizeMeetingCode(code) },
      include: { participants: true, invites: true }
    });

    if (!meeting) {
      return NextResponse.json({ error: "Reunión no encontrada." }, { status: 404 });
    }

    const canSeePrivateMeetingData = Boolean(session && (session.user.id === meeting.hostId || session.user.rank === "ADMIN"));

    return NextResponse.json({
      meeting: serializeMeeting(meeting, {
        includeInvites: canSeePrivateMeetingData,
        includeParticipantEmails: canSeePrivateMeetingData
      })
    });
  } catch (error) {
    return apiErrorResponse(error, { fallbackMessage: "No se pudo buscar la reunión." });
  }
}

function normalizeMeetingCode(code: string) {
  return decodeURIComponent(code).trim().toUpperCase();
}
