import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const args = process.argv.slice(2);
const json = args.includes("--json");
const noPush = args.includes("--no-push");
const skipVerify = args.includes("--skip-verify");
const envFile = argValue("--env-file");
const fileEnv = envFile ? readEnvFile(resolve(envFile)) : {};
const apiUrl = normalizeBaseUrl(
  argValue("--api-url") ??
    process.env.SHAPE_REMOTE_ADMIN_URL ??
    fileEnv.SHAPE_REMOTE_ADMIN_URL ??
    process.env.SHAPE_DEMO_API_URL ??
    fileEnv.SHAPE_DEMO_API_URL ??
    process.env.SHAPE_SMOKE_API_URL ??
    fileEnv.SHAPE_SMOKE_API_URL ??
    process.env.VITE_SHAPE_API_URL ??
    fileEnv.VITE_SHAPE_API_URL ??
    fileEnv.NEXT_PUBLIC_APP_URL ??
    readEnvFileValue("apps/desktop/.env.local", "VITE_SHAPE_API_URL") ??
    "http://localhost:13000",
);
const adminIdentifier =
  argValue("--admin-identifier") ??
  argValue("--admin-email") ??
  process.env.SHAPE_REMOTE_ADMIN_IDENTIFIER ??
  fileEnv.SHAPE_REMOTE_ADMIN_IDENTIFIER ??
  process.env.SHAPE_REMOTE_ADMIN_EMAIL ??
  fileEnv.SHAPE_REMOTE_ADMIN_EMAIL ??
  fileEnv.ADMIN_BOOTSTRAP_EMAIL ??
  process.env.HOST_BOOTSTRAP_EMAIL ??
  fileEnv.HOST_BOOTSTRAP_EMAIL ??
  readEnvFileValue("apps/admin/.env.local", "HOST_BOOTSTRAP_EMAIL") ??
  "admin@shape.test";
const adminPassword =
  argValue("--admin-password") ??
  process.env.SHAPE_REMOTE_ADMIN_PASSWORD ??
  fileEnv.SHAPE_REMOTE_ADMIN_PASSWORD ??
  fileEnv.ADMIN_BOOTSTRAP_PASSWORD ??
  process.env.HOST_BOOTSTRAP_PASSWORD ??
  fileEnv.HOST_BOOTSTRAP_PASSWORD ??
  readEnvFileValue("apps/admin/.env.local", "HOST_BOOTSTRAP_PASSWORD") ??
  "ChangeMe123!";
const hostIdentifier =
  argValue("--host-identifier") ??
  argValue("--host-email") ??
  argValue("--host") ??
  process.env.SHAPE_REMOTE_HOST_IDENTIFIER ??
  fileEnv.SHAPE_REMOTE_HOST_IDENTIFIER ??
  process.env.SHAPE_REMOTE_HOST_EMAIL ??
  fileEnv.SHAPE_REMOTE_HOST_EMAIL ??
  process.env.VITE_SHAPE_HOST_IDENTIFIER ??
  fileEnv.VITE_SHAPE_HOST_IDENTIFIER ??
  null;
const hostPassword =
  argValue("--host-password") ??
  process.env.SHAPE_REMOTE_HOST_PASSWORD ??
  fileEnv.SHAPE_REMOTE_HOST_PASSWORD ??
  null;
const artifactFile = argValue("--artifact-file");
const identityName =
  argValue("--name") ??
  argValue("--identity-name") ??
  process.env.SHAPE_DEMO_IDENTITY_NAME ??
  `Identidad ${new Date().toISOString()}`;
const identityKind =
  argValue("--kind") ??
  process.env.SHAPE_DEMO_IDENTITY_KIND ??
  "PHOTO_IDENTITY";
const identityVersion = argValue("--version") ?? null;

const report = {
  ok: false,
  apiUrl,
  pushed: !noPush,
  verified: false,
  envFile: envFile ? resolve(envFile) : null,
  targetHost: null,
  identity: null,
  checks: [],
  warnings: [],
  nextSteps: [],
};

try {
  await main();
  report.ok = report.checks.every((check) => check.status !== "failed");
  printReport();
  if (!report.ok) process.exit(1);
} catch (error) {
  failCheck("unhandled", errorMessage(error));
  printReport();
  process.exit(1);
}

async function main() {
  if (!artifactFile) {
    throw new Error(
      "Falta --artifact-file. Pasa una foto, DFM/modelo entrenado o artefacto preparado para FaceFusion.",
    );
  }
  if (!existsSync(artifactFile)) {
    throw new Error(`No existe --artifact-file: ${artifactFile}`);
  }

  const artifact = readArtifact(artifactFile);
  okCheck(
    "artifact.local",
    `${artifact.fileName} (${artifact.sizeBytes} bytes, sha256 ${artifact.sha256.slice(0, 12)})`,
  );

  const adminSession = await login(adminIdentifier, adminPassword, "admin");
  if (adminSession.user.rank !== "ADMIN") {
    throw new Error("El usuario admin debe tener rango ADMIN.");
  }
  okCheck("admin.login", `Admin autenticado: ${adminSession.user.email}`);

  const targetHost = hostIdentifier
    ? await resolveHost(adminSession.token, hostIdentifier)
    : adminSession.user;
  report.targetHost = publicUser(targetHost);
  okCheck("host.resolve", `Host destino: ${targetHost.email}`);

  const created = await createIdentity(
    adminSession.token,
    targetHost,
    artifact,
  );
  report.identity = publicIdentity(created);
  okCheck(
    "identity.create",
    `${created.name} ${created.status}/${created.deliveryStatus}`,
  );

  const published = noPush
    ? created
    : await pushIdentity(adminSession.token, created.id);
  report.identity = publicIdentity(published);
  okCheck(
    "identity.push",
    noPush
      ? "Publicación omitida por --no-push."
      : `Publicado: ${published.deliveryStatus}`,
  );

  if (!skipVerify && published.deliveryStatus === "PUSHED") {
    const hostSession =
      hostPassword && hostIdentifier
        ? await login(hostIdentifier, hostPassword, "host")
        : adminSession;

    if (!hostPassword || !hostIdentifier) {
      warn(
        "identity.verify",
        "Verificación hecha con token admin. Para probar permisos exactos del host, pasa --host-identifier y --host-password.",
      );
    }

    await verifyPublishedIdentity(hostSession.token, published, artifact);
    report.verified = true;
  }
}

async function login(identifier, password, label) {
  const data = await jsonRequest("/api/auth/host/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier, password }),
  });
  const session = data.session;
  if (!session?.token || !session.user?.id) {
    throw new Error(`Login ${label} no devolvió session.token.`);
  }
  return session;
}

async function resolveHost(adminToken, identifier) {
  const users = await jsonRequest("/api/users", {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const candidates = Array.isArray(users.users) ? users.users : [];
  const target = candidates.find((user) => {
    const normalized = String(identifier).toLowerCase();
    return (
      user.id === identifier ||
      user.email?.toLowerCase() === normalized ||
      user.username?.toLowerCase() === normalized
    );
  });

  if (!target) {
    throw new Error(`No se encontró host destino: ${identifier}`);
  }
  if (!["HOST", "ADMIN"].includes(target.rank) || target.status !== "ACTIVE") {
    throw new Error(
      `El usuario destino debe estar ACTIVE y tener rango HOST/ADMIN: ${target.email}`,
    );
  }
  return target;
}

async function createIdentity(adminToken, host, artifact) {
  const form = new FormData();
  form.set("userId", host.id);
  form.set("name", identityName);
  form.set("kind", identityKind);
  form.set("status", "AVAILABLE");
  form.set("version", identityVersion ?? `demo-${artifact.sha256.slice(0, 8)}`);
  form.set(
    "artifactFile",
    new Blob([artifact.bytes], { type: artifact.contentType }),
    artifact.fileName,
  );

  const data = await jsonRequest("/api/admin/identities", {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}` },
    body: form,
  });
  const identity = data.identity;

  if (
    !identity?.id ||
    identity.status !== "AVAILABLE" ||
    !identity.artifactSha256 ||
    !identity.artifactSizeBytes
  ) {
    throw new Error("La API no devolvió identidad AVAILABLE con artefacto.");
  }
  if (identity.artifactSha256 !== artifact.sha256) {
    throw new Error("SHA256 del artefacto subido no coincide con el local.");
  }
  if (identity.artifactSizeBytes !== artifact.sizeBytes) {
    throw new Error("Tamaño del artefacto subido no coincide con el local.");
  }

  return identity;
}

async function pushIdentity(adminToken, identityId) {
  const data = await jsonRequest(
    `/api/admin/identities/${encodeURIComponent(identityId)}/delivery`,
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "push" }),
    },
  );
  const identity = data.identity;
  if (identity?.deliveryStatus !== "PUSHED") {
    throw new Error("La API no devolvió deliveryStatus=PUSHED.");
  }
  return identity;
}

async function verifyPublishedIdentity(token, identity, artifact) {
  const listed = await jsonRequest("/api/host/identities", {
    headers: { authorization: `Bearer ${token}` },
  });
  const identities = Array.isArray(listed.identities) ? listed.identities : [];
  if (!identities.some((item) => item.id === identity.id)) {
    throw new Error(
      "La identidad publicada no aparece en /api/host/identities.",
    );
  }
  okCheck("identity.host-list", "Identidad visible para cliente host.");

  const resolved = await jsonRequest(
    `/api/host/identities/${encodeURIComponent(identity.id)}/artifact`,
    {
      headers: { authorization: `Bearer ${token}` },
    },
  );
  const downloadUrl = resolved.artifact?.downloadUrl;
  if (!downloadUrl) {
    throw new Error("El endpoint de artefacto no devolvió downloadUrl.");
  }
  okCheck("identity.artifact-url", "URL firmada de artefacto resuelta.");

  const response = await fetch(downloadUrl);
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  if (!response.ok) {
    throw new Error(`Descarga de artefacto devolvió HTTP ${response.status}.`);
  }
  if (sha256 !== artifact.sha256 || bytes.byteLength !== artifact.sizeBytes) {
    throw new Error("Descarga de artefacto no coincide con SHA/tamaño local.");
  }
  okCheck("identity.artifact-download", "Artefacto descarga y valida SHA256.");
}

async function jsonRequest(path, init = {}) {
  const response = await fetch(`${apiUrl}${path}`, init);
  const text = await response.text();
  const data = parseJson(text) ?? {};

  if (!response.ok) {
    const detail = data?.code
      ? `${data.code}: ${data.error ?? text.slice(0, 240)}`
      : (data?.error ?? text.slice(0, 240) ?? `HTTP ${response.status}`);
    throw new Error(`${path} HTTP ${response.status}: ${detail}`);
  }

  return data;
}

function readArtifact(filePath) {
  const bytes = readFileSync(filePath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    bytes,
    sha256,
    sizeBytes: bytes.byteLength,
    fileName: basename(filePath),
    contentType: contentTypeFor(filePath),
  };
}

function contentTypeFor(filePath) {
  if (/\.jpe?g$/i.test(filePath)) return "image/jpeg";
  if (/\.png$/i.test(filePath)) return "image/png";
  if (/\.webp$/i.test(filePath)) return "image/webp";
  return "application/octet-stream";
}

function okCheck(id, detail) {
  report.checks.push({ id, status: "ok", detail });
}

function failCheck(id, detail) {
  report.checks.push({ id, status: "failed", detail });
}

function warn(id, detail) {
  report.warnings.push(detail);
  report.checks.push({ id, status: "warning", detail });
}

function printReport() {
  if (json) {
    console.log(JSON.stringify(redact(report), null, 2));
    return;
  }

  console.log("Shape Meet identity push");
  console.log(`Admin/API: ${apiUrl}`);
  if (report.targetHost) {
    console.log(`Host: ${report.targetHost.email}`);
  }
  if (report.identity) {
    console.log(
      `Identidad: ${report.identity.name} ${report.identity.status}/${report.identity.deliveryStatus}`,
    );
  }
  for (const check of report.checks) {
    console.log(`${check.status}: ${check.id}: ${check.detail}`);
  }
  for (const warning of report.warnings) console.warn(`warning: ${warning}`);
  console.log(report.ok ? "identity push ok" : "identity push failed");
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    rank: user.rank,
    status: user.status,
  };
}

function publicIdentity(identity) {
  return {
    id: identity.id,
    name: identity.name,
    ownerEmail: identity.ownerEmail ?? null,
    kind: identity.kind,
    status: identity.status,
    deliveryStatus: identity.deliveryStatus,
    version: identity.version,
    artifactSha256: identity.artifactSha256,
    artifactSizeBytes: identity.artifactSizeBytes,
  };
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeBaseUrl(value) {
  return String(value ?? "").replace(/\/$/, "");
}

function argValue(name) {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

function readEnvFileValue(file, key) {
  if (!existsSync(file)) return null;

  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;
    if (line.slice(0, equalsIndex).trim() !== key) continue;
    return line
      .slice(equalsIndex + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
  }

  return null;
}

function readEnvFile(file) {
  if (!existsSync(file)) {
    throw new Error(`No existe --env-file: ${file}`);
  }

  const values = {};
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;
    const key = line.slice(0, equalsIndex).trim();
    values[key] = line
      .slice(equalsIndex + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
  }
  return values;
}

function redact(input) {
  if (Array.isArray(input)) return input.map((item) => redact(item));
  if (!input || typeof input !== "object") return input;
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      /password|secret|token|dsn|auth/i.test(key)
        ? "<redacted>"
        : redact(value),
    ]),
  );
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
