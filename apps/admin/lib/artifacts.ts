import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

const ARTIFACT_PROTOCOL = "shape-artifact:";
const ARTIFACT_HOST = "local";
const DEFAULT_MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_ARTIFACT_STORAGE_DIR = "/tmp/shape-meet-artifacts";

export interface StoredIdentityArtifact {
  uri: string;
  sha256: string;
  sizeBytes: number;
  fileName: string;
}

export interface ResolvedIdentityArtifact {
  path: string;
  fileName: string;
  sizeBytes: number;
}

export function isStoredArtifactUri(uri: string | null | undefined) {
  return Boolean(uri?.startsWith(`${ARTIFACT_PROTOCOL}//${ARTIFACT_HOST}/`));
}

export function getArtifactStorageDir() {
  const configured = process.env.SHAPE_ARTIFACT_STORAGE_DIR?.trim();
  return configured || DEFAULT_ARTIFACT_STORAGE_DIR;
}

export async function storeIdentityArtifact(file: File): Promise<StoredIdentityArtifact> {
  if (!file || file.size <= 0) {
    throw new Error("Selecciona un artefacto válido.");
  }

  const maxBytes = maxArtifactBytes();
  if (file.size > maxBytes) {
    throw new Error(`El artefacto supera el límite configurado de ${maxBytes} bytes.`);
  }

  const artifactId = randomUUID();
  const fileName = sanitizeFileName(file.name || "identity-artifact.bin");
  const artifactDir = path.join(/*turbopackIgnore: true*/ getArtifactStorageDir(), artifactId);
  const targetPath = path.join(/*turbopackIgnore: true*/ artifactDir, fileName);
  const tempPath = `${targetPath}.part`;

  await mkdir(/*turbopackIgnore: true*/ artifactDir, { recursive: true });

  try {
    const hasher = createHash("sha256");
    let sizeBytes = 0;
    const source = Readable.fromWeb(file.stream() as unknown as Parameters<typeof Readable.fromWeb>[0]);
    const target = createWriteStream(/*turbopackIgnore: true*/ tempPath, { flags: "wx" });

    await new Promise<void>((resolve, reject) => {
      source.on("data", (chunk: Buffer) => {
        sizeBytes += chunk.length;
        hasher.update(chunk);

        if (sizeBytes > maxBytes) {
          source.destroy(new Error(`El artefacto supera el límite configurado de ${maxBytes} bytes.`));
        }
      });
      source.on("error", reject);
      target.on("error", reject);
      target.on("finish", resolve);
      source.pipe(target);
    });

    await rm(/*turbopackIgnore: true*/ targetPath, { force: true });
    await renameArtifact(tempPath, targetPath);

    return {
      uri: storedArtifactUri(artifactId, fileName),
      sha256: hasher.digest("hex"),
      sizeBytes,
      fileName
    };
  } catch (error) {
    await rm(/*turbopackIgnore: true*/ tempPath, { force: true }).catch(() => undefined);
    await rm(/*turbopackIgnore: true*/ artifactDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function removeStoredArtifact(uri: string | null | undefined) {
  if (!isStoredArtifactUri(uri)) return;

  const artifact = parseStoredArtifactUri(uri as string);
  const artifactDir = path.join(/*turbopackIgnore: true*/ getArtifactStorageDir(), artifact.artifactId);
  await rm(/*turbopackIgnore: true*/ artifactDir, { recursive: true, force: true });
}

export async function resolveStoredArtifact(uri: string): Promise<ResolvedIdentityArtifact> {
  const artifact = parseStoredArtifactUri(uri);
  const root = getArtifactStorageDir();
  const artifactPath = path.join(/*turbopackIgnore: true*/ root, artifact.artifactId, artifact.fileName);
  const relativeArtifactPath = path.relative(root, artifactPath);

  if (relativeArtifactPath.startsWith("..") || path.isAbsolute(relativeArtifactPath)) {
    throw new Error("URI de artefacto inválida.");
  }

  const metadata = await stat(/*turbopackIgnore: true*/ artifactPath);
  if (!metadata.isFile()) {
    throw new Error("Artefacto no encontrado.");
  }

  return {
    path: artifactPath,
    fileName: artifact.fileName,
    sizeBytes: metadata.size
  };
}

export function artifactResponseStream(artifact: ResolvedIdentityArtifact) {
  return Readable.toWeb(createReadStream(/*turbopackIgnore: true*/ artifact.path)) as ReadableStream<Uint8Array>;
}

export function contentDispositionAttachment(fileName: string) {
  const safeName = fileName.replaceAll('"', "'");
  return `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function storedArtifactUri(artifactId: string, fileName: string) {
  return `${ARTIFACT_PROTOCOL}//${ARTIFACT_HOST}/${artifactId}/${encodeURIComponent(fileName)}`;
}

function parseStoredArtifactUri(uri: string) {
  let parsed: URL;

  try {
    parsed = new URL(uri);
  } catch {
    throw new Error("URI de artefacto inválida.");
  }

  if (parsed.protocol !== ARTIFACT_PROTOCOL || parsed.hostname !== ARTIFACT_HOST) {
    throw new Error("URI de artefacto inválida.");
  }

  const segments = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const [artifactId, fileName] = segments;

  if (!artifactId || !fileName || segments.length !== 2 || !isSafePathSegment(artifactId) || !isSafePathSegment(fileName)) {
    throw new Error("URI de artefacto inválida.");
  }

  return { artifactId, fileName };
}

function sanitizeFileName(fileName: string) {
  const baseName = path.basename(fileName).normalize("NFKD");
  const safe = baseName.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^[-.]+/, "");
  return safe.slice(0, 160) || "identity-artifact.bin";
}

function isSafePathSegment(value: string) {
  return value.length > 0 && !value.includes("/") && !value.includes("\\") && value !== "." && value !== "..";
}

function maxArtifactBytes() {
  const configured = Number(process.env.SHAPE_ARTIFACT_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_ARTIFACT_BYTES;
}

async function renameArtifact(from: string, to: string) {
  const { rename } = await import("node:fs/promises");
  await rename(from, to);
}
