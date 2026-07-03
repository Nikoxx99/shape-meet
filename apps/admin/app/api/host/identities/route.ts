import { NextResponse } from "next/server";
import { getAuthenticatedHost } from "../../../../lib/auth";
import { prisma } from "../../../../lib/prisma";
import { serializeIdentity } from "../../../../lib/formatters";
import { apiErrorResponse } from "../../../../lib/api-errors";

export async function GET(request: Request) {
  try {
    const session = await getAuthenticatedHost(request);

    if (!session) {
      return NextResponse.json({ error: "Sesión inválida." }, { status: 401 });
    }

    const identities = await prisma.hostIdentity.findMany({
      where: {
        status: "AVAILABLE",
        deliveryStatus: "PUSHED",
        ...(session.user.rank === "ADMIN" ? {} : { userId: session.user.id })
      },
      orderBy: [{ status: "asc" }, { updatedAt: "desc" }]
    });

    return NextResponse.json({ identities: identities.map(serializeIdentity) });
  } catch (error) {
    return apiErrorResponse(error, { fallbackMessage: "No se pudieron cargar las identidades del host." });
  }
}
