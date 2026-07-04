import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const apiUrl = (
  argValue("--api-url") ??
  process.env.SHAPE_DEMO_API_URL ??
  process.env.SHAPE_SMOKE_API_URL ??
  process.env.VITE_SHAPE_API_URL ??
  readEnvFileValue("apps/desktop/.env.local", "VITE_SHAPE_API_URL") ??
  "http://localhost:13000"
).replace(/\/$/, "");
const hostIdentifier =
  argValue("--host") ??
  argValue("--host-identifier") ??
  process.env.SHAPE_DEMO_HOST_IDENTIFIER ??
  process.env.SHAPE_SMOKE_HOST_IDENTIFIER ??
  readEnvFileValue("apps/desktop/.env.local", "VITE_SHAPE_HOST_IDENTIFIER") ??
  readEnvFileValue("apps/admin/.env.local", "HOST_BOOTSTRAP_EMAIL") ??
  "admin@shape.test";
const hostPassword =
  argValue("--password") ??
  argValue("--host-password") ??
  process.env.SHAPE_DEMO_HOST_PASSWORD ??
  process.env.SHAPE_SMOKE_HOST_PASSWORD ??
  readEnvFileValue("apps/admin/.env.local", "HOST_BOOTSTRAP_PASSWORD") ??
  "ChangeMe123!";

await main();

async function main() {
  const session = await loginHost();
  const identity = await findPublishedIdentity(session.token);
  const artifact = await resolveIdentityArtifact(session.token, identity.id);
  const downloadUrl = artifact.downloadUrl;

  if (!downloadUrl) {
    fail("El endpoint de artefacto no devolvió downloadUrl.");
  }

  const response = await fetch(downloadUrl);
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const expectedSha256 = artifact.artifactSha256 ?? identity.artifactSha256;
  const expectedSize = artifact.artifactSizeBytes ?? identity.artifactSizeBytes;

  if (!response.ok) {
    fail(`Descarga de artefacto devolvió HTTP ${response.status}.`);
  }
  if (expectedSha256 && sha256 !== expectedSha256) {
    fail(
      `SHA256 de artefacto no coincide: esperado ${expectedSha256}, recibido ${sha256}.`,
    );
  }
  if (expectedSize && bytes.byteLength !== expectedSize) {
    fail(
      `Tamaño de artefacto no coincide: esperado ${expectedSize}, recibido ${bytes.byteLength}.`,
    );
  }

  console.log(
    `identity artifact ok: ${identity.name} ${bytes.byteLength} bytes sha256=${sha256.slice(0, 12)}`,
  );
}

async function loginHost() {
  const data = await jsonRequest("/api/auth/host/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      identifier: hostIdentifier,
      password: hostPassword,
    }),
  });
  const session = data.session;

  if (!session?.token || !session.user?.id) {
    fail("Login host no devolvió session.token.");
  }

  return session;
}

async function findPublishedIdentity(token) {
  const data = await jsonRequest("/api/host/identities", {
    headers: { authorization: `Bearer ${token}` },
  });
  const identities = Array.isArray(data.identities) ? data.identities : [];
  const identity = identities.find(
    (item) =>
      item.status === "AVAILABLE" &&
      item.deliveryStatus === "PUSHED" &&
      item.artifactUri &&
      item.artifactSha256 &&
      Number(item.artifactSizeBytes) > 0,
  );

  if (!identity) {
    fail(
      "No hay identidad AVAILABLE/PUSHED con artefacto. Ejecuta `pnpm demo:prepare` primero.",
    );
  }

  return identity;
}

async function resolveIdentityArtifact(token, identityId) {
  const data = await jsonRequest(
    `/api/host/identities/${encodeURIComponent(identityId)}/artifact`,
    {
      headers: { authorization: `Bearer ${token}` },
    },
  );

  if (!data.artifact?.downloadUrl) {
    fail("No se pudo resolver URL firmada de artefacto.");
  }

  return data.artifact;
}

async function jsonRequest(path, init = {}) {
  const response = await fetch(`${apiUrl}${path}`, init);
  const text = await response.text();
  const data = parseJson(text) ?? {};

  if (!response.ok) {
    fail(
      `${path} HTTP ${response.status}: ${data.error ?? text.slice(0, 240)}`,
    );
  }

  return data;
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function readEnvFileValue(file, key) {
  if (!existsSync(file)) return null;

  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;
    const currentKey = line.slice(0, equalsIndex).trim();
    if (currentKey !== key) continue;
    let value = line.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }

  return null;
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
