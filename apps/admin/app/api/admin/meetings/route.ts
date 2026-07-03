import { NextResponse } from "next/server";
import { getAuthenticatedAdmin } from "../../../../lib/auth";
import { serializeMeeting } from "../../../../lib/formatters";
import { prisma } from "../../../../lib/prisma";
import { apiErrorResponse } from "../../../../lib/api-errors";

export async function GET(request: Request) {
  try {
    const session = await getAuthenticatedAdmin(request);
    if (!session) return NextResponse.json({ error: "Sesión admin requerida." }, { status: 401 });

    const meetings = await prisma.meeting.findMany({
      include: {
        host: true,
        participants: true,
        invites: true
      },
      orderBy: [{ startsAt: "asc" }, { createdAt: "desc" }]
    });

    return NextResponse.json({
      meetings: meetings.map((meeting) => ({
        ...serializeMeeting(meeting),
        hostName: meeting.host.username,
        hostEmail: meeting.host.email,
        participantCount: meeting.participants.filter((participant) => !participant.leftAt).length,
        createdAt: meeting.createdAt.toISOString(),
        updatedAt: meeting.updatedAt.toISOString()
      }))
    });
  } catch (error) {
    return apiErrorResponse(error, { fallbackMessage: "No se pudieron cargar las reuniones del admin." });
  }
}
