import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "../../../../../lib/prisma";
import { serializeUser } from "../../../../../lib/formatters";
import { getAuthenticatedAdmin } from "../../../../../lib/auth";
import { apiErrorResponse } from "../../../../../lib/api-errors";

const updateStatusSchema = z.object({
  status: z.enum(["ACTIVE", "DISABLED"]),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAuthenticatedAdmin(request);
    if (!session)
      return NextResponse.json(
        { error: "Sesión admin requerida." },
        { status: 401 },
      );

    const { id } = await context.params;
    const input = updateStatusSchema.parse(await request.json());
    const targetUser = await prisma.user.findUnique({ where: { id } });

    if (!targetUser) {
      return NextResponse.json(
        { error: "Usuario no encontrado." },
        { status: 404 },
      );
    }

    if (targetUser.rank === "ADMIN") {
      return NextResponse.json(
        { error: "No se puede cambiar una cuenta admin desde este panel." },
        { status: 403 },
      );
    }

    const user = await prisma.user.update({
      where: { id },
      data: { status: input.status },
    });

    await prisma.auditLog.create({
      data: {
        actorId: session.user.id,
        action: "USER_STATUS_CHANGED",
        targetId: id,
        metadata: { status: input.status },
      },
    });

    return NextResponse.json({ user: serializeUser(user) });
  } catch (error) {
    return apiErrorResponse(error, {
      fallbackMessage: "No se pudo actualizar el estado del usuario.",
    });
  }
}
