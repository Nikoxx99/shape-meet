import type { Metadata } from "next";
import { prisma } from "../../../lib/prisma";
import { MeetingLauncher } from "./meeting-launcher";

type PageParams = {
  params: Promise<{ code: string }>;
};

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const { code } = await params;
  const normalizedCode = normalizeMeetingCode(code);

  return {
    title: normalizedCode ? `${normalizedCode} | Shape Meet` : "Shape Meet",
    description: "Abrir reunión en Shape Meet",
  };
}

export default async function PublicMeetingPage({ params }: PageParams) {
  const { code } = await params;
  const normalizedCode = normalizeMeetingCode(code);
  const valid = isMeetingCode(normalizedCode);
  const meeting = valid ? await publicMeetingSummary(normalizedCode) : null;

  return (
    <MeetingLauncher
      nativeUrl={valid ? `shapemeet://r/${normalizedCode}` : null}
      meeting={{
        code: normalizedCode || code,
        title: meeting?.title ?? "Reunión",
        startsAt: meeting?.startsAt?.toISOString() ?? null,
        status: meeting?.status ?? null,
        maxParticipants: meeting?.maxParticipants ?? null,
        found: Boolean(meeting),
        valid,
      }}
    />
  );
}

async function publicMeetingSummary(code: string) {
  try {
    return await prisma.meeting.findUnique({
      where: { code },
      select: {
        title: true,
        code: true,
        startsAt: true,
        status: true,
        maxParticipants: true,
      },
    });
  } catch (error) {
    console.error("[shape-meeting-launcher] meeting lookup failed", error);
    return null;
  }
}

function normalizeMeetingCode(code: string) {
  try {
    return decodeURIComponent(code).trim().toUpperCase();
  } catch {
    return code.trim().toUpperCase();
  }
}

function isMeetingCode(code: string) {
  return /^SM-\d{3}-\d{3}$/.test(code);
}
