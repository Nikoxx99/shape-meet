import { SignJWT, jwtVerify } from "jose";
import type { UserRank } from "@prisma/client";
import { prisma } from "./prisma";
import { serializeUser } from "./formatters";

const TOKEN_TTL = "12h";

interface HostTokenPayload {
  sub: string;
  email: string;
  username: string;
  rank: UserRank;
}

interface ArtifactTokenInput {
  userId: string;
  identityId: string;
  artifactUri: string;
  admin: boolean;
}

export function readBearerToken(request: Request) {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

export function readCookieToken(request: Request) {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;

  const cookie = cookieHeader
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith("shape_host_token="));

  return cookie ? decodeURIComponent(cookie.slice("shape_host_token=".length)) : null;
}

export async function signHostToken(payload: HostTokenPayload) {
  return new SignJWT({
    email: payload.email,
    username: payload.username,
    rank: payload.rank
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(getJwtSecret());
}

export async function verifyHostToken(token: string) {
  const { payload } = await jwtVerify(token, getJwtSecret());

  if (!payload.sub || typeof payload.email !== "string" || typeof payload.username !== "string") {
    throw new Error("Invalid host token");
  }

  return {
    sub: payload.sub,
    email: payload.email,
    username: payload.username,
    rank: payload.rank as UserRank
  };
}

export async function signArtifactDownloadToken(input: ArtifactTokenInput) {
  return new SignJWT({
    kind: "shape-artifact-download",
    identityId: input.identityId,
    artifactUri: input.artifactUri,
    admin: input.admin
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(input.userId)
    .setAudience("shape-artifact")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(getJwtSecret());
}

export async function verifyArtifactDownloadToken(token: string) {
  const { payload } = await jwtVerify(token, getJwtSecret(), {
    audience: "shape-artifact"
  });

  if (
    payload.kind !== "shape-artifact-download" ||
    !payload.sub ||
    typeof payload.identityId !== "string" ||
    typeof payload.artifactUri !== "string"
  ) {
    throw new Error("Invalid artifact token");
  }

  return {
    userId: payload.sub,
    identityId: payload.identityId,
    artifactUri: payload.artifactUri,
    admin: payload.admin === true
  };
}

export async function getAuthenticatedHost(request: Request) {
  const token = readBearerToken(request) ?? readCookieToken(request);
  if (!token) return null;

  const payload = await verifyHostToken(token);
  const user = await prisma.user.findUnique({ where: { id: payload.sub } });

  if (!user || user.status !== "ACTIVE" || (user.rank !== "HOST" && user.rank !== "ADMIN")) {
    return null;
  }

  return {
    token,
    user,
    serializedUser: serializeUser(user)
  };
}

export async function getAuthenticatedAdmin(request: Request) {
  const session = await getAuthenticatedHost(request);

  if (!session || session.user.rank !== "ADMIN") {
    return null;
  }

  return session;
}

function getJwtSecret() {
  const secret = process.env.AUTH_SESSION_SECRET;

  if (!secret && process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SESSION_SECRET is required in production");
  }

  return new TextEncoder().encode(secret ?? "shape-meet-local-dev-secret-change-me");
}
