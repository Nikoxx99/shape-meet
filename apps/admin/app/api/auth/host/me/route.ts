import { NextResponse } from "next/server";
import { getAuthenticatedHost } from "../../../../../lib/auth";
import { apiErrorResponse } from "../../../../../lib/api-errors";

export async function GET(request: Request) {
  try {
    const session = await getAuthenticatedHost(request).catch(() => null);

    return NextResponse.json({ user: session?.serializedUser ?? null });
  } catch (error) {
    return apiErrorResponse(error, {
      fallbackMessage: "No se pudo restaurar la sesión.",
    });
  }
}
