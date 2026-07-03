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
const guestName = process.env.SHAPE_SMOKE_GUEST_NAME ?? "Invitada Smoke";
const guestEmail = process.env.SHAPE_SMOKE_GUEST_EMAIL ?? "smoke.guest@example.com";

await main();

async function main() {
  const login = await request("/api/auth/host/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier, password })
  });
  assertOk("host login", login);
  const token = login.data.session?.token;
  if (!token) fail("host login", login, "No session token returned.");
  console.log(`login ok: ${login.data.session.user.email} rank=${login.data.session.user.rank}`);

  const created = await request("/api/meetings", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      title: `Smoke flow ${new Date().toISOString()}`,
      startsAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      access: "PUBLIC_LINK",
      maxParticipants: 4,
      invitedEmails: []
    })
  });
  assertOk("create meeting", created, 201);
  const meeting = created.data.meeting;
  if (!meeting?.code) fail("create meeting", created, "No meeting code returned.");
  console.log(`meeting created: ${meeting.code}`);

  const access = await request(`/api/meetings/${encodeURIComponent(meeting.code)}/waiting-room`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      displayName: guestName,
      email: guestEmail,
      camera: false,
      microphone: false
    })
  });
  assertOk("waiting room", access);
  const participantId = access.data.participantId;
  if (!participantId) fail("waiting room", access, "No participant id returned.");
  assertParticipantMedia("waiting room", access.data.meeting, participantId, { camera: "off", mic: "muted" }, access);
  console.log(`waiting room ok: ${participantId}`);

  const earlyJoin = await request(`/api/meetings/${encodeURIComponent(meeting.code)}/join-token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      displayName: guestName,
      camera: false,
      microphone: false,
      participantId
    })
  });
  assertStatus("guest join before admit", earlyJoin, 409, "WAITING_FOR_HOST");
  console.log("pre-admit guard ok: WAITING_FOR_HOST");

  const admitted = await request(
    `/api/meetings/${encodeURIComponent(meeting.code)}/participants/${encodeURIComponent(participantId)}/admit`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    }
  );
  assertOk("admit participant", admitted);
  console.log("admit ok");

  const guestJoin = await request(`/api/meetings/${encodeURIComponent(meeting.code)}/join-token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      displayName: guestName,
      camera: false,
      microphone: true,
      participantId
    })
  });
  assertOk("guest join", guestJoin);
  if (!guestJoin.data.livekit?.token) fail("guest join", guestJoin, "No LiveKit token returned for guest.");
  assertParticipantMedia("guest join", guestJoin.data.meeting, participantId, { camera: "off", mic: "on" }, guestJoin);
  console.log(`guest join ok: room=${guestJoin.data.livekit.room}`);

  const guestMediaUpdate = await request(
    `/api/meetings/${encodeURIComponent(meeting.code)}/participants/${encodeURIComponent(participantId)}/media`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        camera: true,
        microphone: false
      })
    }
  );
  assertOk("guest media update", guestMediaUpdate);
  assertParticipantMedia("guest media update", guestMediaUpdate.data.meeting, participantId, { camera: "on", mic: "muted" }, guestMediaUpdate);
  console.log("guest media update ok");

  const hostJoin = await request(`/api/meetings/${encodeURIComponent(meeting.code)}/join-token`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      displayName: login.data.session.user.username,
      camera: true,
      microphone: true
    })
  });
  assertOk("host join", hostJoin);
  if (!hostJoin.data.livekit?.token) fail("host join", hostJoin, "No LiveKit token returned for host.");
  assertParticipantMedia("host join", hostJoin.data.meeting, hostJoin.data.livekit.identity, { camera: "on", mic: "on" }, hostJoin);
  console.log(`host join ok: identity=${hostJoin.data.livekit.identity}`);

  const hostMediaUpdate = await request(
    `/api/meetings/${encodeURIComponent(meeting.code)}/participants/${encodeURIComponent(hostJoin.data.livekit.identity)}/media`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        camera: false,
        microphone: false
      })
    }
  );
  assertOk("host media update", hostMediaUpdate);
  assertParticipantMedia("host media update", hostMediaUpdate.data.meeting, hostJoin.data.livekit.identity, { camera: "off", mic: "muted" }, hostMediaUpdate);
  console.log("host media update ok");

  const ended = await request(`/api/meetings/${encodeURIComponent(meeting.code)}/end`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` }
  });
  assertOk("end meeting", ended);
  if (ended.data.meeting?.status !== "ENDED") fail("end meeting", ended, "Meeting status is not ENDED.");
  console.log("end ok");
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
  if (expectedStatus !== null) {
    assertStatus(label, result, expectedStatus);
    return;
  }

  if (!result.response.ok) fail(label, result);
}

function assertStatus(label, result, expectedStatus, expectedCode = null) {
  if (result.response.status !== expectedStatus) fail(label, result, `Expected HTTP ${expectedStatus}.`);
  if (expectedCode && result.data.code !== expectedCode) {
    fail(label, result, `Expected code ${expectedCode}.`);
  }
}

function assertParticipantMedia(label, meeting, participantId, expected, result) {
  const participant = meeting?.participants?.find((item) => item.id === participantId);
  if (!participant) fail(label, result, `Participant ${participantId} not returned.`);
  if (participant.camera !== expected.camera || participant.mic !== expected.mic) {
    fail(
      label,
      result,
      `Expected participant media camera=${expected.camera}, mic=${expected.mic}; got camera=${participant.camera}, mic=${participant.mic}.`
    );
  }
}

function fail(label, result, message = null) {
  console.error(`${label} failed: HTTP ${result.response.status}`);
  if (message) console.error(message);
  console.error(JSON.stringify(redact(result.data), null, 2));
  process.exit(1);
}

function readEnvFileValue(file, key) {
  if (!existsSync(file)) return null;

  const line = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .find((item) => item.startsWith(`${key}=`));

  if (!line) return null;

  return line.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, "");
}

function redact(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redact);

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      /token|password|secret|dsn|key/i.test(key) ? "<redacted>" : redact(entry)
    ])
  );
}
