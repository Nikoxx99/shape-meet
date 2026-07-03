import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../../lib/prisma";
import { hashPassword } from "../../../lib/passwords";
import { serializeUser } from "../../../lib/formatters";
import { getAuthenticatedAdmin } from "../../../lib/auth";
import { apiErrorResponse } from "../../../lib/api-errors";

const createUserSchema = z.object({
  username: z.string().trim().min(3).max(32),
  email: z.string().trim().email().transform((email) => email.toLowerCase()),
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
        email: input.email,
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
    const uniquenessError = userUniquenessErrorResponse(error);
    if (uniquenessError) return uniquenessError;

    return apiErrorResponse(error, { fallbackMessage: "No se pudo crear el usuario." });
  }
}

function userUniquenessErrorResponse(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return null;
  }

  const fields = uniqueConstraintFields(error);
  const label = fields.includes("email")
    ? "correo"
    : fields.includes("username")
      ? "usuario"
      : "usuario";

  return NextResponse.json(
    {
      error: `Ya existe un usuario con ese ${label}.`,
      code: "USER_ALREADY_EXISTS"
    },
    { status: 409 }
  );
}

function uniqueConstraintFields(error: Prisma.PrismaClientKnownRequestError) {
  const target = error.meta?.target;
  if (Array.isArray(target)) return target.map(String);
  return typeof target === "string" ? [target] : [];
}
