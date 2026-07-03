import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthenticatedAdmin } from "../../../../../../lib/auth";
import {
  artifactReadinessError,
  deliveryStatusForIdentity,
  hasPublishableArtifact
} from "../../../../../../lib/identity-delivery";
import { serializeIdentity } from "../../../../../../lib/formatters";
import { prisma } from "../../../../../../lib/prisma";
import { apiErrorResponse } from "../../../../../../lib/api-errors";

const deliverySchema = z.object({
  action: z.enum(["push", "unpush"])
});

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await getAuthenticatedAdmin(request);
    if (!session) return NextResponse.json({ error: "Sesión admin requerida." }, { status: 401 });

    const { id } = await context.params;
    const input = deliverySchema.parse(await request.json());
    const current = await prisma.hostIdentity.findUnique({
      where: { id },
      include: { user: true }
    });

    if (!current) {
      return NextResponse.json({ error: "Rostro no encontrado." }, { status: 404 });
    }

    if (input.action === "push" && (current.status !== "AVAILABLE" || !hasPublishableArtifact(current))) {
      return NextResponse.json({ error: artifactReadinessError() }, { status: 422 });
    }

    const identity = await prisma.hostIdentity.update({
      where: { id },
      data:
        input.action === "push"
          ? {
              deliveryStatus: "PUSHED",
              publishedAt: new Date()
            }
          : {
              deliveryStatus: deliveryStatusForIdentity(current),
              publishedAt: null
            },
      include: { user: true }
    });

    await prisma.auditLog.create({
      data: {
        actorId: session.user.id,
        action: input.action === "push" ? "IDENTITY_PUSHED" : "IDENTITY_UNPUSHED",
        targetId: identity.id,
        metadata: {
          name: identity.name,
          artifactUri: identity.artifactUri,
          deliveryStatus: identity.deliveryStatus
        }
      }
    });

    return NextResponse.json({
      identity: {
        ...serializeIdentity(identity),
        ownerName: identity.user.username,
        ownerEmail: identity.user.email,
        createdAt: identity.createdAt.toISOString(),
        updatedAt: identity.updatedAt.toISOString()
      }
    });
  } catch (error) {
    return apiErrorResponse(error, { fallbackMessage: "No se pudo actualizar la entrega del rostro." });
  }
}
