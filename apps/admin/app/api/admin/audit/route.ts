import { NextResponse } from "next/server";
import { getAuthenticatedAdmin } from "../../../../lib/auth";
import { prisma } from "../../../../lib/prisma";
import { apiErrorResponse } from "../../../../lib/api-errors";

export async function GET(request: Request) {
  try {
    const session = await getAuthenticatedAdmin(request);
    if (!session) return NextResponse.json({ error: "Sesión admin requerida." }, { status: 401 });

    const logs = await prisma.auditLog.findMany({
      include: { actor: true },
      orderBy: { createdAt: "desc" },
      take: 100
    });

    return NextResponse.json({
      logs: logs.map((log) => ({
        id: log.id,
        action: log.action,
        targetId: log.targetId,
        actorId: log.actorId,
        actorName: log.actor?.username ?? "Sistema",
        actorEmail: log.actor?.email ?? null,
        metadata: log.metadata,
        createdAt: log.createdAt.toISOString()
      }))
    });
  } catch (error) {
    return apiErrorResponse(error, { fallbackMessage: "No se pudo cargar la auditoría." });
  }
}
