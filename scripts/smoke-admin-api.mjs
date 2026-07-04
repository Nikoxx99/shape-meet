import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const apiUrl = (
  process.env.SHAPE_SMOKE_API_URL ??
  process.env.VITE_SHAPE_API_URL ??
  readEnvFileValue("apps/desktop/.env.local", "VITE_SHAPE_API_URL") ??
  "http://127.0.0.1:3000"
).replace(/\/$/, "");
const identifier =
  process.env.SHAPE_SMOKE_HOST_IDENTIFIER ??
  readEnvFileValue("apps/admin/.env.local", "HOST_BOOTSTRAP_EMAIL") ??
  "admin@shape.test";
const password =
  process.env.SHAPE_SMOKE_HOST_PASSWORD ??
  readEnvFileValue("apps/admin/.env.local", "HOST_BOOTSTRAP_PASSWORD") ??
  "ChangeMe123!";

await main();

async function main() {
  const health = await request("/api/health");
  if (!health.response.ok) {
    printFailure("health", health);
    process.exit(1);
  }
  console.log(
    `health ok: ${health.data.service} database=${health.data.database ?? "unknown"}`,
  );

  const login = await request("/api/auth/host/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier, password }),
  });
  if (!login.response.ok || !login.data.session?.token) {
    printFailure("host login", login);
    process.exit(1);
  }
  console.log(
    `login ok: ${login.data.session.user.email} rank=${login.data.session.user.rank}`,
  );
  const token = login.data.session.token;

  const meetings = await request("/api/meetings", {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!meetings.response.ok || !Array.isArray(meetings.data.meetings)) {
    printFailure("meetings", meetings);
    process.exit(1);
  }
  console.log(`meetings ok: ${meetings.data.meetings.length}`);

  const smokeMeeting = await request("/api/meetings", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      title: `Smoke admin ${new Date().toISOString()}`,
      startsAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      access: "INVITE_ONLY",
      maxParticipants: 4,
      invitedEmails: [],
    }),
  });
  if (
    !smokeMeeting.response.ok ||
    smokeMeeting.data.meeting?.status !== "SCHEDULED"
  ) {
    printFailure("meeting create", smokeMeeting);
    process.exit(1);
  }
  console.log(`meeting create ok: ${smokeMeeting.data.meeting.code}`);

  const endedMeeting = await request(
    `/api/meetings/${encodeURIComponent(smokeMeeting.data.meeting.code)}/end`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    },
  );
  if (
    !endedMeeting.response.ok ||
    endedMeeting.data.meeting?.status !== "ENDED"
  ) {
    printFailure("meeting end", endedMeeting);
    process.exit(1);
  }
  console.log("meeting end ok");

  const suffix = Date.now().toString(36);
  const userPayload = {
    username: `smoke_${suffix}`,
    email: `smoke_${suffix}@shape.test`,
    password: "ChangeMe123!",
    rank: "HOST",
  };
  const createdUser = await request("/api/users", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(userPayload),
  });
  if (!createdUser.response.ok || createdUser.data.user?.rank !== "HOST") {
    printFailure("create user", createdUser);
    process.exit(1);
  }
  console.log(`user create ok: ${createdUser.data.user.email}`);

  const incompleteIdentity = await request("/api/admin/identities", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: createdUser.data.user.id,
      name: `Smoke incomplete ${suffix}`,
      kind: "PHOTO_IDENTITY",
      status: "AVAILABLE",
      version: "smoke",
      artifactUri: "https://example.invalid/identity.dfm",
    }),
  });
  if (
    !incompleteIdentity.response.ok ||
    incompleteIdentity.data.identity?.deliveryStatus !== "PENDING"
  ) {
    printFailure("identity incomplete create", incompleteIdentity);
    process.exit(1);
  }
  console.log("identity incomplete guard ok");

  const rejectedPush = await patchIdentityDelivery(
    incompleteIdentity.data.identity.id,
    "push",
    token,
  );
  if (rejectedPush.response.status !== 422) {
    printFailure("identity incomplete push guard", rejectedPush);
    process.exit(1);
  }
  console.log("identity incomplete push rejected ok");

  const identityForm = new FormData();
  const artifactPayload = `shape-smoke-artifact:${suffix}`;
  identityForm.set("userId", createdUser.data.user.id);
  identityForm.set("name", `Smoke artifact ${suffix}`);
  identityForm.set("kind", "PHOTO_IDENTITY");
  identityForm.set("status", "AVAILABLE");
  identityForm.set("version", "smoke");
  identityForm.set(
    "artifactFile",
    new Blob([artifactPayload], {
      type: "application/octet-stream",
    }),
    "smoke-identity.bin",
  );

  const completeIdentity = await request("/api/admin/identities", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: identityForm,
  });
  if (
    !completeIdentity.response.ok ||
    completeIdentity.data.identity?.deliveryStatus !== "READY" ||
    !completeIdentity.data.identity?.artifactSha256 ||
    !completeIdentity.data.identity?.artifactSizeBytes
  ) {
    printFailure("identity artifact create", completeIdentity);
    process.exit(1);
  }
  console.log("identity artifact create ok");

  const pushedIdentity = await patchIdentityDelivery(
    completeIdentity.data.identity.id,
    "push",
    token,
  );
  if (pushedIdentity.data.identity?.deliveryStatus !== "PUSHED") {
    printFailure("identity push", pushedIdentity);
    process.exit(1);
  }
  console.log("identity push ok");

  await assertHostArtifactDelivery(
    token,
    pushedIdentity.data.identity,
    artifactPayload,
  );
  console.log("identity host artifact download ok");

  const unpushedIdentity = await patchIdentityDelivery(
    completeIdentity.data.identity.id,
    "unpush",
    token,
  );
  if (unpushedIdentity.data.identity?.deliveryStatus !== "READY") {
    printFailure("identity unpush", unpushedIdentity);
    process.exit(1);
  }
  console.log("identity unpush ok");

  const disabledUser = await patchUserStatus(
    createdUser.data.user.id,
    "DISABLED",
    token,
  );
  if (disabledUser.data.user?.status !== "DISABLED") {
    printFailure("disable user", disabledUser);
    process.exit(1);
  }
  console.log("user disable ok");

  const activeUser = await patchUserStatus(
    createdUser.data.user.id,
    "ACTIVE",
    token,
  );
  if (activeUser.data.user?.status !== "ACTIVE") {
    printFailure("activate user", activeUser);
    process.exit(1);
  }
  console.log("user activate ok");
}

function patchUserStatus(userId, status, token) {
  return request(`/api/users/${encodeURIComponent(userId)}/status`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ status }),
  });
}

function patchIdentityDelivery(identityId, action, token) {
  return request(
    `/api/admin/identities/${encodeURIComponent(identityId)}/delivery`,
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action }),
    },
  );
}

async function assertHostArtifactDelivery(token, identity, expectedPayload) {
  const hostIdentities = await request("/api/host/identities", {
    headers: { authorization: `Bearer ${token}` },
  });
  if (
    !hostIdentities.response.ok ||
    !hostIdentities.data.identities?.some((item) => item.id === identity.id)
  ) {
    printFailure("host identities delivery", hostIdentities);
    process.exit(1);
  }

  const artifact = await request(
    `/api/host/identities/${encodeURIComponent(identity.id)}/artifact`,
    {
      headers: { authorization: `Bearer ${token}` },
    },
  );
  if (!artifact.response.ok || !artifact.data.artifact?.downloadUrl) {
    printFailure("host identity artifact", artifact);
    process.exit(1);
  }

  const download = await fetch(artifact.data.artifact.downloadUrl);
  const downloaded = Buffer.from(await download.arrayBuffer());
  const expectedSha = createHash("sha256")
    .update(expectedPayload)
    .digest("hex");
  const actualSha = createHash("sha256").update(downloaded).digest("hex");

  if (
    !download.ok ||
    downloaded.toString("utf8") !== expectedPayload ||
    actualSha !== expectedSha ||
    download.headers.get("x-shape-artifact-sha256") !== expectedSha
  ) {
    console.error(
      `host identity artifact download failed: HTTP ${download.status}`,
    );
    console.error(
      JSON.stringify(
        {
          expectedSha,
          actualSha,
          headerSha: download.headers.get("x-shape-artifact-sha256"),
          size: downloaded.byteLength,
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }
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

function printFailure(label, result) {
  console.error(`${label} failed: HTTP ${result.response.status}`);
  console.error(JSON.stringify(redact(result.data), null, 2));
}

function readEnvFileValue(file, key) {
  if (!existsSync(file)) return null;

  const line = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .find((item) => item.startsWith(`${key}=`));

  if (!line) return null;

  return line
    .slice(key.length + 1)
    .trim()
    .replace(/^['"]|['"]$/g, "");
}

function redact(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redact);

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      /token|password|secret|dsn|key/i.test(key) ? "<redacted>" : redact(entry),
    ]),
  );
}
