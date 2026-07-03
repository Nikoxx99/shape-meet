import { NextResponse } from "next/server";
import { AccessToken } from "livekit-server-sdk";
import { z } from "zod";
import { apiErrorResponse } from "../../../../lib/api-errors";
import { getAuthenticatedHost } from "../../../../lib/auth";

const tokenSchema = z.object({
  room: z.string().min(3),
  identity: z.string().min(2),
  name: z.string().min(2),
  canPublish: z.boolean().default(true),
  canSubscribe: z.boolean().default(true)
});

export async function POST(request: Request) {
  try {
    const session = await getAuthenticatedHost(request);
    if (!session) return NextResponse.json({ error: "Sesión host requerida." }, { status: 401 });

    const input = tokenSchema.parse(await request.json());
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;

    if (!apiKey || !apiSecret) {
      return NextResponse.json({ error: "LIVEKIT_API_KEY y LIVEKIT_API_SECRET son requeridos." }, { status: 500 });
    }

    const token = new AccessToken(apiKey, apiSecret, {
      identity: input.identity,
      name: input.name
    });

    token.addGrant({
      room: input.room,
      roomJoin: true,
      canPublish: input.canPublish,
      canSubscribe: input.canSubscribe
    });

    return NextResponse.json({
      token: await token.toJwt(),
      url: process.env.LIVEKIT_URL
    });
  } catch (error) {
    return apiErrorResponse(error, { fallbackMessage: "No se pudo emitir token LiveKit." });
  }
}
