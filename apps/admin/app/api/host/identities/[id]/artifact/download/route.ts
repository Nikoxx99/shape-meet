import { NextResponse } from "next/server";
import {
  artifactResponseStream,
  contentDispositionAttachment,
  isStoredArtifactUri,
  resolveStoredArtifact
} from "../../../../../../../lib/artifacts";
import { getAuthenticatedHost, verifyArtifactDownloadToken } from "../../../../../../../lib/auth";
import { prisma } from "../../../../../../../lib/prisma";
import { apiErrorResponse } from "../../../../../../../lib/api-errors";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const url = new URL(request.url);
    const token = url.searchParams.get("token");
    const grant = token ? await verifyArtifactDownloadToken(token).catch(() => null) : null;
    const session = grant ? null : await getAuthenticatedHost(request);

    if (!grant && !session) {
      return NextResponse.json({ error: "Sesión inválida." }, { status: 401 });
    }

    if (grant && grant.identityId !== id) {
      return NextResponse.json({ error: "Token de artefacto inválido." }, { status: 401 });
    }

    const identity = await prisma.hostIdentity.findFirst({
      where: {
        id,
        status: "AVAILABLE",
        deliveryStatus: "PUSHED",
        ...(grant
          ? {
              artifactUri: grant.artifactUri,
              ...(grant.admin ? {} : { userId: grant.userId })
            }
          : session?.user.rank === "ADMIN"
            ? {}
            : { userId: session?.user.id })
      }
    });

    if (!identity?.artifactUri || !isStoredArtifactUri(identity.artifactUri)) {
      return NextResponse.json({ error: "Artefacto no encontrado." }, { status: 404 });
    }

    const artifact = await resolveStoredArtifact(identity.artifactUri).catch(() => null);

    if (!artifact) {
      return NextResponse.json({ error: "Archivo de artefacto no encontrado." }, { status: 404 });
    }

    return new Response(artifactResponseStream(artifact), {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(artifact.sizeBytes),
        "content-disposition": contentDispositionAttachment(artifact.fileName),
        "cache-control": "private, no-store",
        "x-shape-artifact-sha256": identity.artifactSha256 ?? "",
        "x-shape-artifact-size": String(identity.artifactSizeBytes ?? artifact.sizeBytes)
      }
    });
  } catch (error) {
    return apiErrorResponse(error, { fallbackMessage: "No se pudo descargar el artefacto." });
  }
}
