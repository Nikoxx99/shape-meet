import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright";

const args = new Set(process.argv.slice(2));
const headed = args.has("--headed");
const browserChannel =
  process.env.SHAPE_SMOKE_BROWSER_CHANNEL ??
  (args.has("--chrome") ? "chrome" : undefined);
const skipStack =
  args.has("--skip-stack") || process.env.SHAPE_SMOKE_SKIP_STACK === "1";
const adminUrl = (
  process.env.SHAPE_WEB_GUEST_ROOM_URL ??
  process.env.SHAPE_ADMIN_UI_URL ??
  process.env.SHAPE_SMOKE_ADMIN_URL ??
  process.env.SHAPE_DEMO_API_URL ??
  process.env.SHAPE_SMOKE_API_URL ??
  process.env.VITE_SHAPE_API_URL ??
  readEnvFileValue("apps/desktop/.env.local", "VITE_SHAPE_API_URL") ??
  "http://localhost:13000"
).replace(/\/$/, "");
const identifier =
  process.env.SHAPE_DEMO_HOST_IDENTIFIER ??
  process.env.SHAPE_SMOKE_HOST_IDENTIFIER ??
  readEnvFileValue("apps/admin/.env.local", "HOST_BOOTSTRAP_EMAIL") ??
  "admin@shape.test";
const password =
  process.env.SHAPE_DEMO_HOST_PASSWORD ??
  process.env.SHAPE_SMOKE_HOST_PASSWORD ??
  readEnvFileValue("apps/admin/.env.local", "HOST_BOOTSTRAP_PASSWORD") ??
  "ChangeMe123!";
const guestName = process.env.SHAPE_SMOKE_GUEST_NAME ?? "Invitada Web";

await main();

async function main() {
  await ensureLocalStack();

  const login = await request("/api/auth/host/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier, password }),
  });
  assertOk("host login", login);
  const token = login.data.session?.token;
  if (!token) fail("host login", login, "No session token returned.");

  const created = await request("/api/meetings", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      title: `Smoke web guest ${new Date().toISOString()}`,
      startsAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      access: "PUBLIC_LINK",
      maxParticipants: 4,
      invitedEmails: [],
    }),
  });
  assertOk("create meeting", created, 201);

  const meetingCode = created.data.meeting?.code;
  if (!meetingCode)
    fail("create meeting", created, "No meeting code returned.");

  const browser = await chromium.launch({
    channel: browserChannel,
    headless: !headed,
    args: [
      "--no-sandbox",
      "--autoplay-policy=no-user-gesture-required",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  });
  const context = await browser.newContext();
  await context.grantPermissions(["camera", "microphone"], {
    origin: adminUrl,
  });
  const page = await context.newPage();

  try {
    await page.goto(`${adminUrl}/r/${encodeURIComponent(meetingCode)}`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByTestId("web-guest-prejoin").waitFor({
      state: "visible",
      timeout: 20_000,
    });
    await page.getByText(created.data.meeting.title, { exact: false }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    await page.getByLabel("Nombre").fill(guestName);
    await page.getByRole("button", { name: "Entrar a la reunión" }).click();
    await page
      .locator(
        '[data-testid="web-guest-room"][data-connection-state="connected"]',
      )
      .waitFor({ state: "visible", timeout: 45_000 });
    await page.getByText("Conectado", { exact: false }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
  } catch (error) {
    await captureFailure(page);
    throw error;
  } finally {
    await browser.close();
    const ended = await request(
      `/api/meetings/${encodeURIComponent(meetingCode)}/end`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      },
    );
    if (!ended.response.ok) printFailure("meeting end cleanup", ended);
  }

  console.log(`web guest room smoke ok: ${meetingCode}`);
}

async function ensureLocalStack() {
  const health = await inspectHealth();
  if (health.ok && health.data?.livekit?.status === "ok") return;

  if (skipStack) {
    failMessage(
      [
        `Admin/LiveKit no está listo en ${adminUrl}.`,
        "Levanta el stack y vuelve a correr:",
        "pnpm demo:ready -- --skip-livekit-handshake --no-prepare",
        "pnpm smoke:web-guest-room -- --skip-stack",
      ].join("\n"),
    );
  }

  console.log("Admin/LiveKit no está listo; levantaré el stack local.");
  const result = spawnSync(
    pnpmCommand(),
    ["demo:ready", "--", "--skip-livekit-handshake", "--no-prepare"],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    },
  );

  if (result.status !== 0) {
    failMessage(
      [
        "No se pudo levantar el stack local para el smoke web.",
        "Puedes prepararlo manualmente con:",
        "pnpm demo:ready -- --skip-livekit-handshake --no-prepare",
        "y luego correr:",
        "pnpm smoke:web-guest-room -- --skip-stack",
      ].join("\n"),
    );
  }

  const ready = await inspectHealth();
  if (!ready.ok || ready.data?.livekit?.status !== "ok") {
    failMessage(
      `Admin/LiveKit sigue sin estar listo en ${adminUrl}: ${JSON.stringify(ready.data)}`,
    );
  }
}

async function inspectHealth() {
  try {
    const result = await request("/api/health");
    return {
      ok: result.response.ok,
      data: result.data,
    };
  } catch (error) {
    return {
      ok: false,
      data: {
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function request(path, init = {}) {
  const response = await fetch(`${adminUrl}${path}`, init);
  const text = await response.text();
  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 600) };
  }

  return { response, data, text };
}

function assertOk(label, result, expectedStatus = null) {
  if (expectedStatus !== null && result.response.status !== expectedStatus) {
    fail(label, result, `Expected HTTP ${expectedStatus}.`);
  }

  if (expectedStatus === null && !result.response.ok) fail(label, result);
}

async function captureFailure(page) {
  const file = resolve("output", "playwright", "web-guest-room-failure.png");
  try {
    mkdirSync(dirname(file), { recursive: true });
    await page.screenshot({ path: file, fullPage: true });
    console.error(`Saved web guest room failure screenshot: ${file}`);
  } catch (error) {
    console.error(
      `Could not capture web guest room failure screenshot: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function printFailure(label, result, message = null) {
  console.error(`${label} failed: HTTP ${result.response.status}`);
  if (message) console.error(message);
  console.error(JSON.stringify(redact(result.data), null, 2));
}

function fail(label, result, message = null) {
  printFailure(label, result, message);
  process.exit(1);
}

function failMessage(message) {
  console.error(message);
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

function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
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
