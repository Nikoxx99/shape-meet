import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthenticatedHost, participantTokenMatches } from "../../../../../../../lib/auth";
import { serializeMeeting } from "../../../../../../../lib/formatters";
import { prisma } from "../../../../../../../lib/prisma";
import { apiErrorResponse } from "../../../../../../../lib/api-errors";

const mediaSchema = z
  .object({
    camera: z.boolean().optional(),
    microphone: z.boolean().optional(),
    participantToken: z.string().min(20).optional()
  })
  .refine((input) => input.camera !== undefined || input.microphone !== undefined, {
    message: "Envía al menos un estado de dispositivo."
  });

export async function PATCH(request: Request, context: { params: Promise<{ code: string; participantId: string }> }) {
  try {
    const { code, participantId } = await context.params;
    const input = mediaSchema.parse(await request.json());
    const session = await getAuthenticatedHost(request).catch(() => null);
    const normalizedCode = decodeURIComponent(code).trim().toUpperCase();

    const meeting = await prisma.meeting.findUnique({
      where: { code: normalizedCode },
      include: { participants: true, invites: true }
    });

    if (!meeting) {
      return NextResponse.json({ error: "Reunión no encontrada." }, { status: 404 });
    }

    if (meeting.status === "ENDED") {
      return NextResponse.json({ error: "La reunión ya terminó.", code: "MEETING_ENDED" }, { status: 409 });
    }

    const participant = meeting.participants.find((item) => item.id === participantId);

    if (!participant) {
      return NextResponse.json({ error: "Participante no encontrado." }, { status: 404 });
    }

    if (participant.leftAt) {
      return NextResponse.json({ error: "Esta sesión ya no está activa.", code: "PARTICIPANT_LEFT" }, { status: 409 });
    }

    const canUpdateParticipant =
      participant.userId === session?.user.id ||
      session?.user.id === meeting.hostId ||
      session?.user.rank === "ADMIN";
    const canUpdateGuestParticipant = await participantTokenMatches(input.participantToken, {
      meetingId: meeting.id,
      meetingCode: meeting.code,
      participantId: participant.id
    });

    if (!canUpdateParticipant && !canUpdateGuestParticipant) {
      return NextResponse.json({ error: "No puedes actualizar este participante." }, { status: 403 });
    }

    await prisma.meetingParticipant.update({
      where: { id: participant.id },
      data: {
        ...(input.camera !== undefined ? { cameraEnabled: input.camera } : {}),
        ...(input.microphone !== undefined ? { microphoneEnabled: input.microphone } : {})
      }
    });

    const updatedMeeting = await prisma.meeting.findUniqueOrThrow({
      where: { id: meeting.id },
      include: { participants: true, invites: true }
    });
    const canSeePrivateMeetingData = Boolean(session && (session.user.id === meeting.hostId || session.user.rank === "ADMIN"));

    return NextResponse.json({
      meeting: serializeMeeting(updatedMeeting, {
        includeInvites: canSeePrivateMeetingData,
        includeParticipantEmails: canSeePrivateMeetingData
      })
    });
  } catch (error) {
    return apiErrorResponse(error, { fallbackMessage: "No se pudo actualizar el estado del participante." });
  }
}
