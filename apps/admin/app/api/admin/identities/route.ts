import { NextResponse } from "next/server";
import { z } from "zod";
import { removeStoredArtifact, storeIdentityArtifact } from "../../../../lib/artifacts";
import { getAuthenticatedAdmin } from "../../../../lib/auth";
import { deliveryStatusForIdentity } from "../../../../lib/identity-delivery";
import { prisma } from "../../../../lib/prisma";
import { serializeIdentity } from "../../../../lib/formatters";
import { apiErrorResponse } from "../../../../lib/api-errors";

export const runtime = "nodejs";

const createIdentitySchema = z.object({
  userId: z.string().min(1),
  name: z.string().min(3).max(120),
  kind: z.enum(["PHOTO_IDENTITY", "TRAINED_IDENTITY", "OPEN_MODEL_IDENTITY"]).default("PHOTO_IDENTITY"),
  status: z.enum(["AVAILABLE", "TRAINING", "REVOKED"]).default("TRAINING"),
  version: z.string().min(1).max(40).default("v0"),
  artifactUri: z.string().max(500).optional().nullable(),
  artifactSha256: z.string().max(128).optional().nullable(),
  artifactSizeBytes: z.coerce.number().int().positive().optional().nullable()
});

export async function GET(request: Request) {
  try {
    const session = await getAuthenticatedAdmin(request);
    if (!session) return NextResponse.json({ error: "Sesión admin requerida." }, { status: 401 });

    const identities = await prisma.hostIdentity.findMany({
      include: { user: true },
      orderBy: [{ status: "asc" }, { updatedAt: "desc" }]
    });

    return NextResponse.json({
      identities: identities.map((identity) => ({
        ...serializeIdentity(identity),
        ownerName: identity.user.username,
        ownerEmail: identity.user.email,
        createdAt: identity.createdAt.toISOString(),
        updatedAt: identity.updatedAt.toISOString()
      }))
    });
  } catch (error) {
    return apiErrorResponse(error, { fallbackMessage: "No se pudieron cargar los rostros." });
  }
}

export async function POST(request: Request) {
  const session = await getAuthenticatedAdmin(request);
  if (!session) return NextResponse.json({ error: "Sesión admin requerida." }, { status: 401 });

  let storedArtifactUri: string | null = null;

  try {
    const { input, artifactFile } = await parseCreateIdentityRequest(request);
    const owner = await prisma.user.findUnique({ where: { id: input.userId } });

    if (!owner || (owner.rank !== "HOST" && owner.rank !== "ADMIN")) {
      return NextResponse.json({ error: "Selecciona un usuario con rango host." }, { status: 422 });
    }

    const storedArtifact = artifactFile ? await storeIdentityArtifact(artifactFile) : null;
    storedArtifactUri = storedArtifact?.uri ?? null;
    const artifactUri = (storedArtifact?.uri ?? input.artifactUri?.trim()) || null;
    const artifactSha256 = (storedArtifact?.sha256 ?? input.artifactSha256?.trim()) || null;
    const artifactSizeBytes = storedArtifact?.sizeBytes ?? input.artifactSizeBytes ?? null;
    const deliveryStatus = deliveryStatusForIdentity({
      status: input.status,
      artifactUri,
      artifactSha256,
      artifactSizeBytes
    });

    const identity = await prisma.hostIdentity.create({
      data: {
        userId: input.userId,
        name: input.name,
        kind: input.kind,
        status: input.status,
        version: input.version,
        artifactUri,
        artifactSha256,
        artifactSizeBytes,
        deliveryStatus
      },
      include: { user: true }
    });

    await prisma.auditLog.create({
      data: {
        actorId: session.user.id,
        action: "IDENTITY_CREATED",
        targetId: identity.id,
        metadata: {
          name: identity.name,
          kind: identity.kind,
          status: identity.status,
          artifactUri: identity.artifactUri,
          artifactSha256: identity.artifactSha256,
          artifactSizeBytes: identity.artifactSizeBytes,
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
    }, { status: 201 });
  } catch (error) {
    await removeStoredArtifact(storedArtifactUri).catch(() => undefined);

    return apiErrorResponse(error, { fallbackMessage: "No se pudo crear el rostro." });
  }
}

async function parseCreateIdentityRequest(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";

  if (!contentType.includes("multipart/form-data")) {
    return {
      input: createIdentitySchema.parse(await request.json()),
      artifactFile: null
    };
  }

  const form = await request.formData();
  const file = form.get("artifactFile");

  return {
    input: createIdentitySchema.parse({
      userId: formString(form, "userId"),
      name: formString(form, "name"),
      kind: formString(form, "kind"),
      status: formString(form, "status"),
      version: formString(form, "version"),
      artifactUri: nullableFormString(form, "artifactUri"),
      artifactSha256: nullableFormString(form, "artifactSha256"),
      artifactSizeBytes: nullableFormString(form, "artifactSizeBytes")
    }),
    artifactFile: file instanceof File && file.size > 0 ? file : null
  };
}

function formString(form: FormData, key: string) {
  const value = form.get(key);
  return typeof value === "string" ? value : undefined;
}

function nullableFormString(form: FormData, key: string) {
  const value = formString(form, key)?.trim();
  return value ? value : null;
}
