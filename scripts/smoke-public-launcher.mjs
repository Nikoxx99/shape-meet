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
  const login = await request("/api/auth/host/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier, password })
  });
  assertOk("host login", login);

  const token = login.data.session?.token;
  if (!token) fail("host login", login, "No session token returned.");

  const title = `Launcher smoke ${new Date().toISOString()}`;
  const created = await request("/api/meetings", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      title,
      startsAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      access: "PUBLIC_LINK",
      maxParticipants: 4,
      invitedEmails: []
    })
  });
  assertOk("create meeting", created, 201);

  const meeting = created.data.meeting;
  if (!meeting?.code) fail("create meeting", created, "No meeting code returned.");

  const launcher = await requestText(`/r/${encodeURIComponent(meeting.code)}`);
  assertTextOk("public launcher", launcher);
  assertIncludes("public launcher", launcher, title);
  assertIncludes("public launcher", launcher, meeting.code);
  assertIncludes("public launcher", launcher, `shapemeet://r/${meeting.code}`);
  console.log(`launcher ok: ${meeting.code}`);

  const invalidLauncher = await requestText("/r/not-a-code");
  assertTextOk("invalid launcher", invalidLauncher);
  assertIncludes("invalid launcher", invalidLauncher, "Enlace no válido");
  if (invalidLauncher.text.includes("shapemeet://r/not-a-code")) {
    failText("invalid launcher", invalidLauncher, "Invalid code rendered a native deep link.");
  }
  console.log("invalid launcher ok");
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

  return { response, data, text };
}

async function requestText(path) {
  const response = await fetch(`${apiUrl}${path}`);
  return { response, text: await response.text() };
}

function assertOk(label, result, expectedStatus = null) {
  if (expectedStatus !== null && result.response.status !== expectedStatus) {
    fail(label, result, `Expected HTTP ${expectedStatus}.`);
  }

  if (expectedStatus === null && !result.response.ok) fail(label, result);
}

function assertTextOk(label, result) {
  if (!result.response.ok) failText(label, result);
}

function assertIncludes(label, result, expected) {
  if (!result.text.includes(expected)) {
    failText(label, result, `Expected rendered HTML to include: ${expected}`);
  }
}

function fail(label, result, message = null) {
  console.error(`${label} failed: HTTP ${result.response.status}`);
  if (message) console.error(message);
  console.error(JSON.stringify(redact(result.data), null, 2));
  process.exit(1);
}

function failText(label, result, message = null) {
  console.error(`${label} failed: HTTP ${result.response.status}`);
  if (message) console.error(message);
  console.error(result.text.slice(0, 1200));
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
