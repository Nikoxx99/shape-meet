import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

const apiUrl = (
  process.env.SHAPE_SMOKE_API_URL ??
  process.env.VITE_SHAPE_API_URL ??
  readEnvFileValue("apps/desktop/.env.local", "VITE_SHAPE_API_URL") ??
  "http://127.0.0.1:3000"
).replace(/\/$/, "");
const expectedLiveKitUrl = (
  process.env.SHAPE_SMOKE_LIVEKIT_URL ??
  process.env.SHAPE_DEMO_LIVEKIT_URL ??
  process.env.LIVEKIT_URL ??
  ""
).replace(/\/$/, "");
const identifier =
  process.env.SHAPE_SMOKE_HOST_IDENTIFIER ??
  readEnvFileValue("apps/admin/.env.local", "HOST_BOOTSTRAP_EMAIL") ??
  "admin@shape.test";
const password =
  process.env.SHAPE_SMOKE_HOST_PASSWORD ??
  readEnvFileValue("apps/admin/.env.local", "HOST_BOOTSTRAP_PASSWORD") ??
  "ChangeMe123!";
const timeoutMs = Number(process.env.SHAPE_SMOKE_LIVEKIT_TIMEOUT_MS ?? "8000");

await main();

async function main() {
  const health = await request("/api/health");
  assertOk("health", health);
  if (health.data.livekit?.status !== "ok") {
    fail(
      "health livekit",
      health,
      `LiveKit no está configurado para emitir tokens: ${JSON.stringify(health.data.livekit)}`,
    );
  }
  console.log("health livekit ok");

  const login = await request("/api/auth/host/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier, password }),
  });
  assertOk("host login", login);
  const token = login.data.session?.token;
  if (!token) fail("host login", login, "No session token returned.");
  console.log(`login ok: ${login.data.session.user.email}`);

  let meetingCode = null;
  try {
    const created = await request("/api/meetings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        title: `Smoke LiveKit ${new Date().toISOString()}`,
        startsAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        access: "PUBLIC_LINK",
        maxParticipants: 4,
        invitedEmails: [],
      }),
    });
    assertOk("create meeting", created, 201);
    meetingCode = created.data.meeting?.code;
    if (!meetingCode) fail("create meeting", created, "No meeting code returned.");
    console.log(`meeting created: ${meetingCode}`);

    const joined = await request(
      `/api/meetings/${encodeURIComponent(meetingCode)}/join-token`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          displayName: login.data.session.user.username,
          camera: false,
          microphone: false,
        }),
      },
    );
    assertOk("host join-token", joined);

    const livekit = joined.data.livekit;
    if (!livekit?.url || !livekit?.token || !livekit?.room || !livekit?.identity) {
      fail(
        "host join-token",
        joined,
        "Join-token no devolvió url/token/room/identity de LiveKit.",
      );
    }
    if (expectedLiveKitUrl && livekit.url.replace(/\/$/, "") !== expectedLiveKitUrl) {
      fail(
        "host join-token",
        joined,
        `Join-token usa ${livekit.url}; se esperaba ${expectedLiveKitUrl}.`,
      );
    }
    console.log(`join-token ok: room=${livekit.room} identity=${livekit.identity}`);

    const response = await websocketUpgrade(
      liveKitRtcUrl(livekit.url, livekit.token),
      timeoutMs,
    );
    if (response.statusCode !== 101) {
      fail(
        "livekit handshake",
        { response: { status: response.statusCode }, data: response },
        `LiveKit /rtc devolvió HTTP ${response.statusCode}: ${response.statusText}`,
      );
    }
    console.log(`livekit handshake ok: ${livekit.url} room=${livekit.room}`);
  } finally {
    if (meetingCode) {
      const ended = await request(
        `/api/meetings/${encodeURIComponent(meetingCode)}/end`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        },
      );
      if (ended.response.ok) console.log(`meeting ended: ${meetingCode}`);
      else printFailure("meeting end cleanup", ended);
    }
  }
}

function liveKitRtcUrl(baseUrl, token) {
  const parsed = new URL(baseUrl);
  if (parsed.protocol === "http:") parsed.protocol = "ws:";
  if (parsed.protocol === "https:") parsed.protocol = "wss:";

  const basePath = parsed.pathname.replace(/\/$/, "");
  parsed.pathname = `${basePath}/rtc`;
  parsed.search = "";
  parsed.searchParams.set("access_token", token);
  parsed.searchParams.set("auto_subscribe", "0");
  parsed.searchParams.set("sdk", "shape-local-handshake");
  parsed.searchParams.set("version", "0.1.0");
  parsed.searchParams.set("protocol", "15");
  return parsed.toString();
}

function websocketUpgrade(url, timeout) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const secure = parsed.protocol === "wss:";
    const port = Number(parsed.port || (secure ? 443 : 80));
    const hostHeader = hostHeaderValue(parsed.hostname, parsed.port);
    const key = randomBytes(16).toString("base64");
    const request = [
      `GET ${parsed.pathname}${parsed.search} HTTP/1.1`,
      `Host: ${hostHeader}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      "User-Agent: shape-meet-livekit-handshake",
      "",
      "",
    ].join("\r\n");
    const socket = secure
      ? tlsConnect(
          {
            host: parsed.hostname,
            port,
            servername: parsed.hostname,
          },
          writeRequest,
        )
      : new Socket();
    let raw = "";
    const timer = setTimeout(() => {
      socket.destroy(new Error("timeout"));
    }, timeout);

    if (!secure) socket.once("connect", writeRequest);
    socket.on("data", (chunk) => {
      raw += chunk.toString("utf8");
      if (!raw.includes("\r\n\r\n")) return;

      clearTimeout(timer);
      socket.destroy();
      const [statusLine = ""] = raw.split("\r\n", 1);
      const match = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)\s*(.*)$/);
      if (!match) {
        reject(new Error(`Respuesta WebSocket inválida: ${statusLine}`));
        return;
      }
      resolve({
        statusCode: Number(match[1]),
        statusText: match[2] || "",
      });
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    if (!secure) socket.connect(port, parsed.hostname);

    function writeRequest() {
      socket.write(request);
    }
  });
}

function hostHeaderValue(hostname, port) {
  const host = hostname.includes(":") ? `[${hostname}]` : hostname;
  return port ? `${host}:${port}` : host;
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
    if (result.response.status !== expectedStatus) {
      fail(label, result, `Expected HTTP ${expectedStatus}.`);
    }
    return;
  }

  if (!result.response.ok) fail(label, result);
}

function fail(label, result, message = null) {
  printFailure(label, result, message);
  process.exit(1);
}

function printFailure(label, result, message = null) {
  console.error(`${label} failed: HTTP ${result.response.status}`);
  if (message) console.error(message);
  console.error(JSON.stringify(redact(result.data), null, 2));
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
      /token|password|secret|dsn|key/i.test(key) ? "<redacted>" : redact(entry),
    ]),
  );
}
