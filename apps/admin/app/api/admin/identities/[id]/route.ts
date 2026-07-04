import { NextResponse } from "next/server";
import { removeStoredArtifact } from "../../../../../lib/artifacts";
import { getAuthenticatedAdmin } from "../../../../../lib/auth";
import { serializeIdentity } from "../../../../../lib/formatters";
import { prisma } from "../../../../../lib/prisma";
import { apiErrorResponse } from "../../../../../lib/api-errors";

export const runtime = "nodejs";

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
    const current = await prisma.hostIdentity.findUnique({
      where: { id },
      include: { user: true },
    });

    if (!current) {
      return NextResponse.json(
        { error: "Identidad no encontrada." },
        { status: 404 },
      );
    }

    const identity = await prisma.hostIdentity.delete({
      where: { id },
    });
    let artifactRemoved = true;
    await removeStoredArtifact(current.artifactUri).catch(() => {
      artifactRemoved = false;
    });

    await prisma.auditLog.create({
      data: {
        actorId: session.user.id,
        action: "IDENTITY_DELETED",
        targetId: identity.id,
        metadata: {
          name: current.name,
          ownerEmail: current.user.email,
          artifactUri: current.artifactUri,
          artifactRemoved,
        },
      },
    });

    return NextResponse.json({
      ok: true,
      artifactRemoved,
      identity: {
        ...serializeIdentity(identity),
        ownerName: current.user.username,
        ownerEmail: current.user.email,
        createdAt: current.createdAt.toISOString(),
        updatedAt: current.updatedAt.toISOString(),
      },
    });
  } catch (error) {
    return apiErrorResponse(error, {
      fallbackMessage: "No se pudo eliminar la identidad.",
    });
  }
}
