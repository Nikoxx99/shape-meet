export type UserRank = "USER" | "HOST" | "ADMIN";

export type UserStatus = "ACTIVE" | "PENDING" | "DISABLED";

export type MeetingAccess = "INVITE_ONLY" | "PUBLIC_LINK";

export type MeetingStatus = "SCHEDULED" | "WAITING" | "LIVE" | "ENDED";

export type IdentityKind = "PHOTO_IDENTITY" | "TRAINED_IDENTITY" | "OPEN_MODEL_IDENTITY";

export type IdentityStatus = "AVAILABLE" | "TRAINING" | "REVOKED";

export type IdentityDeliveryStatus = "PENDING" | "READY" | "PUSHED" | "REVOKED";

export interface ShapeUser {
  id: string;
  username: string;
  email: string;
  rank: UserRank;
  status: UserStatus;
  lastAccess: string;
  lastAccessAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  temporaryPassword?: boolean;
}

export interface HostIdentity {
  id: string;
  userId: string;
  name: string;
  kind: IdentityKind;
  status: IdentityStatus;
  version: string;
  artifactUri?: string | null;
  artifactSha256?: string | null;
  artifactSizeBytes?: number | null;
  deliveryStatus?: IdentityDeliveryStatus;
  publishedAt?: string | null;
}

export interface HostIdentityArtifact extends HostIdentity {
  downloadUrl: string | null;
}

export interface Meeting {
  id: string;
  title: string;
  code: string;
  startsAt: string;
  hostId: string;
  access: MeetingAccess;
  status: MeetingStatus;
  maxParticipants: number;
  invitedEmails: string[];
  participants: MeetingParticipant[];
}

export interface MeetingParticipant {
  id: string;
  meetingId?: string;
  displayName: string;
  email?: string | null;
  role: "host" | "guest";
  mic: "on" | "muted";
  camera: "on" | "off";
  admittedAt?: string | null;
  joinedAt?: string | null;
  leftAt?: string | null;
  aiEffects?: {
    faceSwap: boolean;
    background: boolean;
    voice: boolean;
  };
}

export interface HostSession {
  token: string;
  user: ShapeUser;
}

export interface LiveKitConnection {
  url: string | null;
  token: string | null;
  room: string;
  identity: string;
}

export interface MeetingCreateInput {
  title: string;
  startsAt: string;
  access: MeetingAccess;
  maxParticipants: number;
  invitedEmails?: string[];
}

export interface DeviceStatus {
  camera: "ready" | "blocked" | "missing";
  microphone: "ready" | "blocked" | "missing";
  gpu: "ready" | "limited" | "missing";
  aiService: "online" | "offline" | "degraded";
}

export interface PipelineMetric {
  label: string;
  value: string;
  state: "ok" | "warning" | "idle";
}

export const mockUsers: ShapeUser[] = [
  {
    id: "usr_nicolas",
    username: "nicolas",
    email: "nicolas@luxora.co",
    rank: "HOST",
    status: "ACTIVE",
    lastAccess: "Hoy 09:14"
  },
  {
    id: "usr_maria",
    username: "maria",
    email: "maria@luxora.co",
    rank: "USER",
    status: "ACTIVE",
    lastAccess: "Ayer 17:20"
  },
  {
    id: "usr_andres",
    username: "andres",
    email: "andres@luxora.co",
    rank: "HOST",
    status: "PENDING",
    lastAccess: "Nunca",
    temporaryPassword: true
  },
  {
    id: "usr_founder",
    username: "fundador",
    email: "founder@luxora.co",
    rank: "ADMIN",
    status: "ACTIVE",
    lastAccess: "Hoy 10:32"
  }
];

export const mockIdentities: HostIdentity[] = [
  {
    id: "identity_exec",
    userId: "usr_nicolas",
    name: "Executive demo",
    kind: "PHOTO_IDENTITY",
    status: "AVAILABLE",
    version: "v1.0.3",
    artifactUri: "shape://demo/executive-photo",
    artifactSha256: "dev-demo",
    artifactSizeBytes: 0,
    deliveryStatus: "PUSHED",
    publishedAt: new Date(0).toISOString()
  },
  {
    id: "identity_founder",
    userId: "usr_founder",
    name: "Founder avatar",
    kind: "TRAINED_IDENTITY",
    status: "AVAILABLE",
    version: "v2.1.0",
    artifactUri: "shape://demo/founder-dfm",
    artifactSha256: "dev-demo",
    artifactSizeBytes: 0,
    deliveryStatus: "PUSHED",
    publishedAt: new Date(0).toISOString()
  },
  {
    id: "identity_board",
    userId: "usr_andres",
    name: "Board advisor DFM",
    kind: "TRAINED_IDENTITY",
    status: "TRAINING",
    version: "74%",
    deliveryStatus: "PENDING"
  }
];

export const mockMeetings: Meeting[] = [
  {
    id: "meet_luxora_review",
    title: "Entrevista con Laura",
    code: "SM-482-910",
    startsAt: "Hoy 11:30 AM",
    hostId: "usr_nicolas",
    access: "INVITE_ONLY",
    status: "SCHEDULED",
    maxParticipants: 4,
    invitedEmails: ["maria@luxora.co"],
    participants: [
      {
        id: "p_nicolas",
        displayName: "Nicolas Alvarez",
        role: "host",
        mic: "on",
        camera: "on",
        aiEffects: { faceSwap: false, background: true, voice: false }
      },
      {
        id: "p_maria",
        displayName: "Maria R.",
        email: "maria@luxora.co",
        role: "guest",
        mic: "muted",
        camera: "on"
      }
    ]
  },
  {
    id: "meet_demo_internal",
    title: "Deep Mind en Shape Meet",
    code: "SM-104-221",
    startsAt: "Hoy 1:45 PM",
    hostId: "usr_founder",
    access: "PUBLIC_LINK",
    status: "WAITING",
    maxParticipants: 4,
    invitedEmails: [],
    participants: []
  },
  {
    id: "meet_windows_qa",
    title: "Prueba Natalia Vintimilla",
    code: "SM-777-407",
    startsAt: "Hoy 4:00 PM",
    hostId: "usr_andres",
    access: "INVITE_ONLY",
    status: "SCHEDULED",
    maxParticipants: 4,
    invitedEmails: [],
    participants: []
  },
  {
    id: "meet_sales_followup",
    title: "Seguimiento comercial",
    code: "SM-218-604",
    startsAt: "Hoy 5:30 PM",
    hostId: "usr_nicolas",
    access: "INVITE_ONLY",
    status: "SCHEDULED",
    maxParticipants: 4,
    invitedEmails: ["maria@luxora.co"],
    participants: []
  }
];

export const defaultDeviceStatus: DeviceStatus = {
  camera: "ready",
  microphone: "ready",
  gpu: "limited",
  aiService: "offline"
};

export const defaultPipelineMetrics: PipelineMetric[] = [
  { label: "Video", value: "720p / 30 FPS", state: "ok" },
  { label: "Fondo", value: "Matting listo", state: "ok" },
  { label: "Rostro", value: "Sin activar", state: "idle" },
  { label: "Voz", value: "Sin activar", state: "idle" }
];
