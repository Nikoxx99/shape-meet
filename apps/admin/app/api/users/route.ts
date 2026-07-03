import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "../../../lib/prisma";
import { hashPassword } from "../../../lib/passwords";
import { serializeUser } from "../../../lib/formatters";
import { getAuthenticatedAdmin } from "../../../lib/auth";
import { apiErrorResponse } from "../../../lib/api-errors";

const createUserSchema = z.object({
  username: z.string().min(3).max(32),
  email: z.string().email(),
  password: z.string().min(8),
  rank: z.enum(["USER", "HOST"]).default("USER")
});

export async function GET(request: Request) {
  try {
    const session = await getAuthenticatedAdmin(request);
    if (!session) return NextResponse.json({ error: "Sesión admin requerida." }, { status: 401 });

    const users = await prisma.user.findMany({
      orderBy: [{ createdAt: "desc" }]
    });

    return NextResponse.json({ users: users.map(serializeUser) });
  } catch (error) {
    return apiErrorResponse(error, { fallbackMessage: "No se pudieron cargar los usuarios." });
  }
}

export async function POST(request: Request) {
  try {
    const session = await getAuthenticatedAdmin(request);
    if (!session) return NextResponse.json({ error: "Sesión admin requerida." }, { status: 401 });

    const input = createUserSchema.parse(await request.json());
    const passwordHash = await hashPassword(input.password);

    const user = await prisma.user.create({
      data: {
        username: input.username,
        email: input.email.toLowerCase(),
        passwordHash,
        rank: input.rank,
        temporaryPassword: true
      }
    });

    await prisma.auditLog.create({
      data: {
        actorId: session.user.id,
        action: "USER_CREATED",
        targetId: user.id,
        metadata: { rank: input.rank }
      }
    });

    return NextResponse.json({ user: serializeUser(user) }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, { fallbackMessage: "No se pudo crear el usuario." });
  }
}
