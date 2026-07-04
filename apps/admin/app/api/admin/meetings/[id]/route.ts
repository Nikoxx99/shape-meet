import { NextResponse } from "next/server";
import { getAuthenticatedAdmin } from "../../../../../lib/auth";
import { serializeMeeting } from "../../../../../lib/formatters";
import { prisma } from "../../../../../lib/prisma";
import { apiErrorResponse } from "../../../../../lib/api-errors";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAuthenticatedAdmin(request);
    if (!session) {
      return NextResponse.json(
        { error: "Sesión admin requerida." },
        { status: 401 },
      );
    }

    const { id } = await context.params;
    const current = await prisma.meeting.findUnique({
      where: { id },
      include: {
        host: true,
        participants: true,
        invites: true,
      },
    });

    if (!current) {
      return NextResponse.json(
        { error: "Reunión no encontrada." },
        { status: 404 },
      );
    }

    const meeting = await prisma.meeting.delete({
      where: { id },
      include: {
        participants: true,
        invites: true,
      },
    });

    await prisma.auditLog.create({
      data: {
        actorId: session.user.id,
        action: "MEETING_DELETED",
        targetId: meeting.id,
        metadata: {
          title: current.title,
          code: current.code,
          hostEmail: current.host.email,
        },
      },
    });

    return NextResponse.json({
      ok: true,
      meeting: {
        ...serializeMeeting(meeting),
        hostName: current.host.username,
        hostEmail: current.host.email,
        participantCount: 0,
        createdAt: current.createdAt.toISOString(),
        updatedAt: current.updatedAt.toISOString(),
      },
    });
  } catch (error) {
    return apiErrorResponse(error, {
      fallbackMessage: "No se pudo eliminar la reunión.",
    });
  }
}
