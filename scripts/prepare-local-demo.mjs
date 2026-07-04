import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

const args = process.argv.slice(2);
const resetLocalData = !args.includes("--no-reset");
const apiUrl = (
  argValue("--api-url") ??
  process.env.SHAPE_DEMO_API_URL ??
  process.env.SHAPE_SMOKE_API_URL ??
  process.env.VITE_SHAPE_API_URL ??
  readEnvFileValue("apps/desktop/.env.local", "VITE_SHAPE_API_URL") ??
  "http://localhost:13000"
).replace(/\/$/, "");
const appUrl = (
  argValue("--app-url") ??
  process.env.SHAPE_DEMO_APP_URL ??
  process.env.VITE_SHAPE_MEETING_URL ??
  process.env.VITE_SHAPE_APP_URL ??
  readEnvFileValue("apps/desktop/.env.local", "VITE_SHAPE_MEETING_URL") ??
  readEnvFileValue("apps/desktop/.env.local", "VITE_SHAPE_APP_URL") ??
  "http://localhost:1420"
).replace(/\/$/, "");
const identifier =
  argValue("--host") ??
  process.env.SHAPE_DEMO_HOST_IDENTIFIER ??
  process.env.SHAPE_SMOKE_HOST_IDENTIFIER ??
  readEnvFileValue("apps/desktop/.env.local", "VITE_SHAPE_HOST_IDENTIFIER") ??
  readEnvFileValue("apps/admin/.env.local", "HOST_BOOTSTRAP_EMAIL") ??
  "admin@shape.test";
const password =
  argValue("--password") ??
  process.env.SHAPE_DEMO_HOST_PASSWORD ??
  process.env.SHAPE_SMOKE_HOST_PASSWORD ??
  readEnvFileValue("apps/admin/.env.local", "HOST_BOOTSTRAP_PASSWORD") ??
  "ChangeMe123!";
const title =
  argValue("--title") ?? process.env.SHAPE_DEMO_TITLE ?? "Demo Shape Meet";
const identityName =
  argValue("--identity-name") ??
  process.env.SHAPE_DEMO_IDENTITY_NAME ??
  "Rostro demo aprobado";
const identityArtifactFile =
  argValue("--identity-artifact-file") ??
  process.env.SHAPE_DEMO_IDENTITY_ARTIFACT_FILE ??
  null;
const startsInMinutes = positiveInteger(
  argValue("--starts-in-minutes") ?? process.env.SHAPE_DEMO_STARTS_IN_MINUTES,
  20,
);

await main();

async function main() {
  if (resetLocalData) {
    resetKnownLocalDemoData();
  }

  const health = await request("/api/health");
  assertOk("health", health);
  console.log(
    `health ok: ${health.data.service} database=${health.data.database ?? "unknown"}`,
  );

  const login = await request("/api/auth/host/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier, password }),
  });
  assertOk("host login", login);
  const session = login.data.session;
  if (!session?.token || !session.user?.id)
    fail("host login", login, "No session token returned.");
  console.log(`login ok: ${session.user.email} rank=${session.user.rank}`);

  const identity = await ensureDemoIdentity(session);
  console.log(
    `identity ok: ${identity.name} ${identity.status}/${identity.deliveryStatus}`,
  );

  const meeting = await createDemoMeeting(session.token);
  const meetingUrl = `${appUrl}/r/${meeting.code}`;
  console.log(`meeting ok: ${meeting.title} ${meeting.code}`);
  console.log("");
  console.log("Demo listo:");
  console.log(`- Host: ${identifier}`);
  console.log(
    "- Password: usa HOST_BOOTSTRAP_PASSWORD (local default: ChangeMe123!)",
  );
  console.log(`- Meeting code: ${meeting.code}`);
  console.log(`- Public link: ${meetingUrl}`);
  console.log(`- Guest name: Invitada Demo`);
}

async function ensureDemoIdentity(session) {
  const artifact = demoIdentityArtifact();
  const identities = await request("/api/admin/identities", {
    headers: { authorization: `Bearer ${session.token}` },
  });
  assertOk("admin identities", identities);

  const existing = identities.data.identities?.find(
    (identity) =>
      identity.name === identityName &&
      identity.ownerEmail === session.user.email &&
      identity.status === "AVAILABLE" &&
      identity.deliveryStatus === "PUSHED" &&
      isStoredArtifact(identity) &&
      identity.artifactSha256 === artifact.sha256 &&
      identity.artifactSizeBytes === artifact.sizeBytes,
  );
  if (existing) return existing;

  const formData = new FormData();
  formData.set("userId", session.user.id);
  formData.set("name", identityName);
  formData.set("kind", "PHOTO_IDENTITY");
  formData.set("status", "AVAILABLE");
  formData.set("version", artifact.version);
  formData.set(
    "artifactFile",
    new Blob([artifact.bytes], { type: artifact.contentType }),
    artifact.fileName,
  );

  const created = await request("/api/admin/identities", {
    method: "POST",
    headers: { authorization: `Bearer ${session.token}` },
    body: formData,
  });
  assertOk("identity create", created, 201);

  const pushed = await request(
    `/api/admin/identities/${encodeURIComponent(created.data.identity.id)}/delivery`,
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${session.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "push" }),
    },
  );
  assertOk("identity push", pushed);
  return pushed.data.identity;
}

function demoIdentityArtifact() {
  if (identityArtifactFile) {
    if (!existsSync(identityArtifactFile)) {
      console.error(
        `identity artifact file not found: ${identityArtifactFile}`,
      );
      process.exit(1);
    }

    const bytes = readFileSync(identityArtifactFile);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return {
      bytes,
      sha256,
      sizeBytes: bytes.byteLength,
      fileName: basename(identityArtifactFile),
      contentType: contentTypeFor(identityArtifactFile),
      version: `demo-${sha256.slice(0, 8)}`,
    };
  }

  const bytes = tinyJpeg();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    bytes,
    sha256,
    sizeBytes: bytes.byteLength,
    fileName: "shape-demo-identity.jpg",
    contentType: "image/jpeg",
    version: `demo-${sha256.slice(0, 8)}`,
  };
}

function isStoredArtifact(identity) {
  return (
    identity.artifactUri?.startsWith("shape-artifact://local/") &&
    Boolean(identity.artifactSha256) &&
    Number(identity.artifactSizeBytes) > 0
  );
}

function contentTypeFor(filePath) {
  if (/\.jpe?g$/i.test(filePath)) return "image/jpeg";
  if (/\.png$/i.test(filePath)) return "image/png";
  if (/\.webp$/i.test(filePath)) return "image/webp";
  return "application/octet-stream";
}

function tinyJpeg() {
  return Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/Aaf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/Aaf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8Qf//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8Qf//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8Qf//Z",
    "base64",
  );
}

async function createDemoMeeting(token) {
  const startsAt = new Date(
    Date.now() + startsInMinutes * 60_000,
  ).toISOString();
  const created = await request("/api/meetings", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      title,
      startsAt,
      access: "PUBLIC_LINK",
      maxParticipants: 4,
      invitedEmails: [],
    }),
  });
  assertOk("meeting create", created, 201);
  return created.data.meeting;
}

function resetKnownLocalDemoData() {
  const container = "shape-meet-local-shape-postgres-1";
  const probe = spawnSync("docker", ["inspect", container], {
    encoding: "utf8",
  });
  if (probe.status !== 0) {
    console.warn(
      `local reset skipped: docker container ${container} not found`,
    );
    return;
  }

  const sql = [
    "DELETE FROM \"Meeting\" WHERE title LIKE 'Smoke%' OR title LIKE 'Launcher smoke%' OR title LIKE 'Invite rejection UI%' OR title LIKE 'Revisión con Luxora%' OR title = 'Demo Shape Meet';",
    "DELETE FROM \"User\" WHERE email LIKE 'smoke_%@shape.test' OR username LIKE 'smoke_%';",
    "DELETE FROM \"HostIdentity\" WHERE name = 'Rostro demo aprobado' OR name = 'Demo rostro aprobado';",
  ].join(" ");
  const reset = spawnSync(
    "docker",
    [
      "exec",
      container,
      "psql",
      "-U",
      "shape_meet",
      "-d",
      "shape_meet",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      sql,
    ],
    { encoding: "utf8" },
  );

  if (reset.status !== 0) {
    console.warn(`local reset skipped: ${reset.stderr || reset.stdout}`.trim());
    return;
  }

  console.log("local demo data reset ok");
}

async function request(path, init = {}) {
  const response = await fetch(`${apiUrl}${path}`, init);
  const text = await response.text();
  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 600) };
  }

  return { response, data };
}

function assertOk(label, result, expectedStatus = null) {
  if (expectedStatus !== null && result.response.status !== expectedStatus) {
    fail(label, result, `Expected HTTP ${expectedStatus}.`);
  }
  if (expectedStatus === null && !result.response.ok) fail(label, result);
}

function fail(label, result, message = null) {
  console.error(`${label} failed: HTTP ${result.response.status}`);
  if (message) console.error(message);
  console.error(JSON.stringify(result.data, null, 2));
  process.exit(1);
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

function argValue(name) {
  const prefix = `${name}=`;
  return (
    args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null
  );
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
