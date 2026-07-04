import { NextResponse } from "next/server";
import { isStoredArtifactUri } from "../../../../../../lib/artifacts";
import {
  getAuthenticatedHost,
  signArtifactDownloadToken,
} from "../../../../../../lib/auth";
import { serializeIdentity } from "../../../../../../lib/formatters";
import { prisma } from "../../../../../../lib/prisma";
import { apiErrorResponse } from "../../../../../../lib/api-errors";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAuthenticatedHost(request);

    if (!session) {
      return NextResponse.json({ error: "Sesión inválida." }, { status: 401 });
    }

    const { id } = await context.params;
    const identity = await prisma.hostIdentity.findFirst({
      where: {
        id,
        status: "AVAILABLE",
        deliveryStatus: "PUSHED",
        ...(session.user.rank === "ADMIN" ? {} : { userId: session.user.id }),
      },
    });

    if (!identity) {
      return NextResponse.json(
        { error: "Artefacto no encontrado." },
        { status: 404 },
      );
    }

    if (!identity.artifactUri) {
      return NextResponse.json(
        { error: "La identidad no tiene artefacto publicado." },
        { status: 409 },
      );
    }

    const downloadUrl = isStoredArtifactUri(identity.artifactUri)
      ? await signedArtifactDownloadUrl(request, {
          identityId: identity.id,
          artifactUri: identity.artifactUri,
          userId: session.user.id,
          admin: session.user.rank === "ADMIN",
        })
      : identity.artifactUri;

    return NextResponse.json({
      artifact: {
        ...serializeIdentity(identity),
        downloadUrl,
      },
    });
  } catch (error) {
    return apiErrorResponse(error, {
      fallbackMessage: "No se pudo resolver el artefacto de identidad.",
    });
  }
}

async function signedArtifactDownloadUrl(
  request: Request,
  input: {
    identityId: string;
    artifactUri: string;
    userId: string;
    admin: boolean;
  },
) {
  const url = publicRequestUrl(request);
  const token = await signArtifactDownloadToken(input);
  url.pathname = `/api/host/identities/${encodeURIComponent(input.identityId)}/artifact/download`;
  url.search = "";
  url.searchParams.set("token", token);
  return url.toString();
}

function publicRequestUrl(request: Request) {
  const configuredAppUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  const url = configuredAppUrl
    ? new URL(configuredAppUrl)
    : new URL(request.url);
  const forwardedHost =
    firstForwardedHeader(request, "x-forwarded-host") ??
    request.headers.get("host")?.trim();
  const forwardedProto = firstForwardedHeader(request, "x-forwarded-proto");

  if (!configuredAppUrl && forwardedHost) url.host = forwardedHost;
  if (!configuredAppUrl && forwardedProto)
    url.protocol = `${forwardedProto.replace(/:$/, "")}:`;

  return url;
}

function firstForwardedHeader(request: Request, name: string) {
  return request.headers
    .get(name)
    ?.split(",")
    .map((value) => value.trim())
    .find(Boolean);
}
