import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthenticatedHost } from "../../../lib/auth";
import { serializeMeeting } from "../../../lib/formatters";
import { prisma } from "../../../lib/prisma";
import { apiErrorResponse } from "../../../lib/api-errors";

const createMeetingSchema = z.object({
  title: z.string().min(3).max(120),
  startsAt: z.string().datetime(),
  access: z.enum(["INVITE_ONLY", "PUBLIC_LINK"]).default("PUBLIC_LINK"),
  maxParticipants: z.number().int().min(2).max(4).default(4),
  invitedEmails: z.array(z.string().email()).default([]),
});

export async function GET(request: Request) {
  try {
    const session = await getAuthenticatedHost(request);

    if (!session) {
      return NextResponse.json({ error: "Sesión inválida." }, { status: 401 });
    }

    const meetings = await prisma.meeting.findMany({
      where:
        session.user.rank === "ADMIN" ? undefined : { hostId: session.user.id },
      include: { participants: true, invites: true },
      orderBy: [{ startsAt: "asc" }, { createdAt: "desc" }],
    });

    return NextResponse.json({
      meetings: meetings.map((meeting) => serializeMeeting(meeting)),
    });
  } catch (error) {
    return apiErrorResponse(error, {
      fallbackMessage: "No se pudieron cargar las reuniones.",
    });
  }
}

export async function POST(request: Request) {
  try {
    const session = await getAuthenticatedHost(request);

    if (!session) {
      return NextResponse.json({ error: "Sesión inválida." }, { status: 401 });
    }

    const input = createMeetingSchema.parse(await request.json());
    const code = await createUniqueMeetingCode();
    const invitedEmails = normalizeEmails(input.invitedEmails);
    const meeting = await prisma.meeting.create({
      data: {
        title: input.title,
        code,
        startsAt: new Date(input.startsAt),
        access: input.access,
        maxParticipants: input.maxParticipants,
        hostId: session.user.id,
        participants: {
          create: {
            displayName: session.user.username,
            userId: session.user.id,
            role: "host",
            cameraEnabled: true,
            microphoneEnabled: true,
          },
        },
        invites: {
          create: invitedEmails.map((email) => ({ email })),
        },
      },
      include: { participants: true, invites: true },
    });

    await prisma.auditLog.create({
      data: {
        actorId: session.user.id,
        action: "MEETING_CREATED",
        targetId: meeting.id,
        metadata: { code: meeting.code, access: meeting.access, invitedEmails },
      },
    });

    return NextResponse.json(
      { meeting: serializeMeeting(meeting) },
      { status: 201 },
    );
  } catch (error) {
    return apiErrorResponse(error, {
      fallbackMessage: "No se pudo crear la reunión.",
    });
  }
}

async function createUniqueMeetingCode() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = `SM-${randomDigits(3)}-${randomDigits(3)}`;
    const existing = await prisma.meeting.findUnique({ where: { code } });
    if (!existing) return code;
  }

  throw new Error("No se pudo crear un código de reunión único.");
}

function randomDigits(length: number) {
  return Array.from({ length }, () => Math.floor(Math.random() * 10)).join("");
}

function normalizeEmails(emails: string[]) {
  return Array.from(
    new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean)),
  );
}
