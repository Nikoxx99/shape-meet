import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "../../../../../lib/prisma";
import { verifyPassword } from "../../../../../lib/passwords";
import { serializeUser } from "../../../../../lib/formatters";
import { signHostToken } from "../../../../../lib/auth";
import { apiErrorResponse } from "../../../../../lib/api-errors";

const loginSchema = z.object({
  identifier: z.string().min(3),
  password: z.string().min(8)
});

export async function POST(request: Request) {
  try {
    const input = loginSchema.parse(await request.json());
    const user = await prisma.user.findFirst({
      where: {
        OR: [{ email: input.identifier.toLowerCase() }, { username: input.identifier }]
      }
    });

    if (!user || !(await verifyPassword(input.password, user.passwordHash))) {
      return NextResponse.json({ error: "Credenciales inválidas." }, { status: 401 });
    }

    if (user.status !== "ACTIVE") {
      return NextResponse.json({ error: "Usuario inactivo." }, { status: 403 });
    }

    if (user.rank !== "HOST" && user.rank !== "ADMIN") {
      return NextResponse.json({ error: "Este usuario no tiene rango host.", code: "NOT_HOST" }, { status: 403 });
    }

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: { lastAccessAt: new Date() }
    });

    await prisma.auditLog.create({
      data: {
        actorId: updatedUser.id,
        action: "HOST_LOGIN",
        targetId: updatedUser.id,
        metadata: { rank: updatedUser.rank }
      }
    });

    const token = await signHostToken({
      sub: updatedUser.id,
      email: updatedUser.email,
      username: updatedUser.username,
      rank: updatedUser.rank
    });

    const response = NextResponse.json({
      session: {
        token,
        user: serializeUser(updatedUser)
      }
    });

    response.cookies.set("shape_host_token", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 12
    });

    return response;
  } catch (error) {
    return apiErrorResponse(error, { fallbackMessage: "No se pudo iniciar sesión." });
  }
}
