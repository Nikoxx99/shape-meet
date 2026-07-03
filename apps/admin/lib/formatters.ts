import type {
  HostIdentity as HostIdentityModel,
  MeetingInvite as MeetingInviteModel,
  Meeting as MeetingModel,
  MeetingParticipant as MeetingParticipantModel,
  User
} from "@prisma/client";
import type { HostIdentity, Meeting, MeetingParticipant, ShapeUser } from "@shape-meet/shared";

export function serializeUser(user: User): ShapeUser {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    rank: user.rank,
    status: user.status,
    lastAccess: formatLastAccess(user.lastAccessAt),
    lastAccessAt: user.lastAccessAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    temporaryPassword: user.temporaryPassword
  };
}

export function serializeIdentity(identity: HostIdentityModel): HostIdentity {
  return {
    id: identity.id,
    userId: identity.userId,
    name: identity.name,
    kind: identity.kind,
    status: identity.status,
    version: identity.version,
    artifactUri: identity.artifactUri,
    artifactSha256: identity.artifactSha256,
    artifactSizeBytes: identity.artifactSizeBytes,
    deliveryStatus: identity.deliveryStatus,
    publishedAt: identity.publishedAt?.toISOString() ?? null
  };
}

export type MeetingWithParticipants = MeetingModel & {
  participants: MeetingParticipantModel[];
  invites?: MeetingInviteModel[];
};

interface SerializeMeetingOptions {
  includeInvites?: boolean;
  includeParticipantEmails?: boolean;
}

export function serializeMeeting(meeting: MeetingWithParticipants, options: SerializeMeetingOptions = {}): Meeting {
  const includeInvites = options.includeInvites ?? true;
  const includeParticipantEmails = options.includeParticipantEmails ?? true;

  return {
    id: meeting.id,
    title: meeting.title,
    code: meeting.code,
    startsAt: meeting.startsAt.toISOString(),
    hostId: meeting.hostId,
    access: meeting.access,
    status: meeting.status,
    maxParticipants: meeting.maxParticipants,
    invitedEmails: includeInvites ? meeting.invites?.map((invite) => invite.email) ?? [] : [],
    participants: meeting.participants.map((participant) => serializeParticipant(participant, { includeEmail: includeParticipantEmails }))
  };
}

function serializeParticipant(participant: MeetingParticipantModel, options: { includeEmail: boolean }): MeetingParticipant {
  return {
    id: participant.id,
    meetingId: participant.meetingId,
    displayName: participant.displayName,
    email: options.includeEmail ? participant.email : null,
    role: participant.role === "host" ? "host" : "guest",
    mic: participant.microphoneEnabled ? "on" : "muted",
    camera: participant.cameraEnabled ? "on" : "off",
    admittedAt: participant.admittedAt?.toISOString() ?? null,
    joinedAt: participant.joinedAt?.toISOString() ?? null,
    leftAt: participant.leftAt?.toISOString() ?? null
  };
}

function formatLastAccess(lastAccessAt: Date | null) {
  if (!lastAccessAt) return "Nunca";

  const formatter = new Intl.DateTimeFormat("es-CO", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Bogota"
  });

  return formatter.format(lastAccessAt);
}
