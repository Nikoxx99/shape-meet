import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthenticatedAdmin } from "../../../../../../lib/auth";
import { prisma } from "../../../../../../lib/prisma";
import { serializeIdentity } from "../../../../../../lib/formatters";
import { deliveryStatusForIdentity } from "../../../../../../lib/identity-delivery";
import { apiErrorResponse } from "../../../../../../lib/api-errors";

const updateStatusSchema = z.object({
  status: z.enum(["AVAILABLE", "TRAINING", "REVOKED"])
});

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await getAuthenticatedAdmin(request);
    if (!session) return NextResponse.json({ error: "Sesión admin requerida." }, { status: 401 });

    const { id } = await context.params;
    const input = updateStatusSchema.parse(await request.json());
    const current = await prisma.hostIdentity.findUnique({ where: { id } });

    if (!current) {
      return NextResponse.json({ error: "Rostro no encontrado." }, { status: 404 });
    }

    const deliveryStatus = deliveryStatusForIdentity({
      ...current,
      status: input.status,
      currentDeliveryStatus: current.deliveryStatus
    });

    const identity = await prisma.hostIdentity.update({
      where: { id },
      data: {
        status: input.status,
        deliveryStatus,
        publishedAt: deliveryStatus === "PUSHED" ? current.publishedAt : null
      },
      include: { user: true }
    });

    await prisma.auditLog.create({
      data: {
        actorId: session.user.id,
        action: "IDENTITY_STATUS_CHANGED",
        targetId: identity.id,
        metadata: { status: input.status, deliveryStatus }
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
    return apiErrorResponse(error, { fallbackMessage: "No se pudo actualizar el estado del rostro." });
  }
}
