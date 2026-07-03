import type {
  HostIdentity,
  HostIdentityArtifact,
  HostSession,
  LiveKitConnection,
  Meeting,
  MeetingCreateInput,
  ShapeUser,
} from "@shape-meet/shared";

const API_BASE_URL =
  (import.meta.env.VITE_SHAPE_API_URL as string | undefined) ??
  "http://localhost:3000";
const TOKEN_KEY = "shape-meet-host-token";

export class ShapeApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ShapeApiError";
    this.status = status;
    this.code = code;
  }
}

export function getStoredHostToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function storeHostToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearHostToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export async function loginHost(
  identifier: string,
  password: string,
): Promise<HostSession> {
  const data = await request<{ session: HostSession }>("/api/auth/host/login", {
    method: "POST",
    body: JSON.stringify({ identifier, password }),
  });

  storeHostToken(data.session.token);
  return data.session;
}

export async function getCurrentHost(
  token = getStoredHostToken(),
): Promise<ShapeUser | null> {
  if (!token) return null;

  try {
    const data = await request<{ user: ShapeUser | null }>(
      "/api/auth/host/me",
      { token },
    );
    if (!data.user) {
      clearHostToken();
      return null;
    }
    return data.user;
  } catch (error) {
    clearHostToken();
    if (error instanceof ShapeApiError && error.status === 401) return null;
    throw error;
  }
}

export async function listHostMeetings(
  token = getStoredHostToken(),
): Promise<Meeting[]> {
  if (!token) return [];
  const data = await request<{ meetings: Meeting[] }>("/api/meetings", {
    token,
  });
  return data.meetings;
}

export async function createHostMeeting(
  input: MeetingCreateInput,
  token = getStoredHostToken(),
): Promise<Meeting> {
  const data = await request<{ meeting: Meeting }>("/api/meetings", {
    method: "POST",
    token,
    body: JSON.stringify(input),
  });
  return data.meeting;
}

export async function findMeeting(
  codeOrUrl: string,
  token?: string | null,
): Promise<Meeting> {
  const code = extractMeetingCode(codeOrUrl);
  const data = await request<{ meeting: Meeting }>(
    `/api/meetings/${encodeURIComponent(code)}`,
    { token },
  );
  return data.meeting;
}

export async function requestMeetingAccess(input: {
  code: string;
  displayName: string;
  email?: string | null;
  camera: boolean;
  microphone: boolean;
}): Promise<{ meeting: Meeting; participantId: string }> {
  return request(
    `/api/meetings/${encodeURIComponent(input.code)}/waiting-room`,
    {
      method: "POST",
      body: JSON.stringify({
        displayName: input.displayName,
        email: input.email ?? undefined,
        camera: input.camera,
        microphone: input.microphone,
      }),
    },
  );
}

export async function admitMeetingParticipant(input: {
  code: string;
  participantId: string;
  token?: string | null;
}): Promise<Meeting> {
  const data = await request<{ meeting: Meeting }>(
    `/api/meetings/${encodeURIComponent(input.code)}/participants/${encodeURIComponent(input.participantId)}/admit`,
    {
      method: "POST",
      token: input.token,
    },
  );

  return data.meeting;
}

export async function listHostIdentities(
  token = getStoredHostToken(),
): Promise<HostIdentity[]> {
  if (!token) return [];
  const data = await request<{ identities: HostIdentity[] }>(
    "/api/host/identities",
    { token },
  );
  return data.identities;
}

export async function getHostIdentityArtifact(
  identityId: string,
  token = getStoredHostToken(),
): Promise<HostIdentityArtifact> {
  const data = await request<{ artifact: HostIdentityArtifact }>(
    `/api/host/identities/${encodeURIComponent(identityId)}/artifact`,
    { token },
  );
  return data.artifact;
}

export async function requestMeetingToken(input: {
  code: string;
  displayName: string;
  camera: boolean;
  microphone: boolean;
  participantId?: string | null;
  token?: string | null;
}): Promise<{
  meeting: Meeting;
  livekit: LiveKitConnection & { warning?: string };
}> {
  return request(`/api/meetings/${encodeURIComponent(input.code)}/join-token`, {
    method: "POST",
    token: input.token,
    body: JSON.stringify({
      displayName: input.displayName,
      camera: input.camera,
      microphone: input.microphone,
      participantId: input.participantId ?? undefined,
    }),
  });
}

export async function leaveMeeting(input: {
  code: string;
  participantId: string;
  token?: string | null;
}): Promise<Meeting> {
  const data = await request<{ meeting: Meeting }>(
    `/api/meetings/${encodeURIComponent(input.code)}/leave`,
    {
      method: "POST",
      token: input.token,
      body: JSON.stringify({
        participantId: input.participantId,
      }),
    },
  );

  return data.meeting;
}

export async function updateMeetingParticipantMedia(input: {
  code: string;
  participantId: string;
  camera?: boolean;
  microphone?: boolean;
  token?: string | null;
}): Promise<Meeting> {
  const data = await request<{ meeting: Meeting }>(
    `/api/meetings/${encodeURIComponent(input.code)}/participants/${encodeURIComponent(input.participantId)}/media`,
    {
      method: "PATCH",
      token: input.token,
      body: JSON.stringify({
        camera: input.camera,
        microphone: input.microphone,
      }),
    },
  );

  return data.meeting;
}

export async function endMeeting(input: {
  code: string;
  token?: string | null;
}): Promise<Meeting> {
  const data = await request<{ meeting: Meeting }>(
    `/api/meetings/${encodeURIComponent(input.code)}/end`,
    {
      method: "POST",
      token: input.token,
    },
  );

  return data.meeting;
}

export function extractMeetingCode(codeOrUrl: string) {
  const trimmed = codeOrUrl.trim();
  const match = trimmed.match(/SM-\d{3}-\d{3}/i);
  return (match?.[0] ?? trimmed).toUpperCase();
}

async function request<T>(
  path: string,
  options: RequestInit & { token?: string | null } = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("accept", "application/json");

  if (options.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  if (options.token) {
    headers.set("authorization", `Bearer ${options.token}`);
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
  });

  const data = (await response.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
  };

  if (!response.ok) {
    throw new ShapeApiError(
      data.error ?? "La API no respondió correctamente.",
      response.status,
      data.code,
    );
  }

  return data as T;
}
