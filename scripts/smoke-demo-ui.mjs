import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright";

const args = new Set(process.argv.slice(2));
const headed = args.has("--headed");
const skipFinalPrepare = args.has("--skip-final-prepare");
const appUrl = (
  process.env.SHAPE_DEMO_APP_URL ??
  process.env.VITE_SHAPE_MEETING_URL ??
  process.env.VITE_SHAPE_APP_URL ??
  readEnvFileValue("apps/desktop/.env.local", "VITE_SHAPE_MEETING_URL") ??
  readEnvFileValue("apps/desktop/.env.local", "VITE_SHAPE_APP_URL") ??
  "http://localhost:1420"
).replace(/\/$/, "");
const apiUrl = (
  process.env.SHAPE_DEMO_API_URL ??
  process.env.SHAPE_SMOKE_API_URL ??
  process.env.VITE_SHAPE_API_URL ??
  readEnvFileValue("apps/desktop/.env.local", "VITE_SHAPE_API_URL") ??
  "http://localhost:13000"
).replace(/\/$/, "");
const expectedLiveKitUrl =
  process.env.SHAPE_DEMO_LIVEKIT_URL?.replace(/\/$/, "") ?? null;
const hostIdentifier =
  process.env.SHAPE_DEMO_HOST_IDENTIFIER ??
  readEnvFileValue("apps/desktop/.env.local", "VITE_SHAPE_HOST_IDENTIFIER") ??
  readEnvFileValue("apps/admin/.env.local", "HOST_BOOTSTRAP_EMAIL") ??
  "admin@shape.test";
const hostPassword =
  process.env.SHAPE_DEMO_HOST_PASSWORD ??
  readEnvFileValue("apps/admin/.env.local", "HOST_BOOTSTRAP_PASSWORD") ??
  "ChangeMe123!";
const guestName = process.env.SHAPE_DEMO_GUEST_NAME ?? "Invitada";

await main();

async function main() {
  await assertReachableApp();
  const prepared = runPnpmCapture("demo:prepare");
  const meetingCode = matchRequired(
    prepared.stdout,
    /Meeting code:\s+(SM-[A-Z0-9-]+)/,
    "meeting code",
  );
  const publicLink = matchRequired(
    prepared.stdout,
    /Public link:\s+(\S+)/,
    "public link",
  );
  await assertDemoLiveKitTarget(meetingCode);

  console.log("");
  console.log(`UI smoke meeting: ${meetingCode}`);

  const browser = await chromium.launch({
    headless: !headed,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--no-sandbox",
    ],
  });

  const hostContext = await browser.newContext({
    permissions: ["camera", "microphone"],
  });
  const guestContext = await browser.newContext({
    permissions: ["camera", "microphone"],
  });
  const hostPage = await hostContext.newPage();
  const guestPage = await guestContext.newPage();

  try {
    await enterGuestWaitingRoom(guestPage, publicLink, meetingCode);
    await enterHostCall(hostPage, meetingCode);
    await assertHostAiVideoBridge(hostPage);
    await assertHostAiAudioBridge(hostPage);
    await admitGuest(hostPage, guestPage);
    await guestJoinsCall(guestPage, meetingCode);
    await assertGuestReceivesHostAiVideo(guestPage);
    await assertGuestReceivesHostAudio(guestPage);
    await expectVisibleText(hostPage, "2 participantes", 20_000);
    await expectVisibleText(guestPage, "2 participantes", 20_000);
  } catch (error) {
    await captureFailure(hostPage, "host");
    await captureFailure(guestPage, "guest");
    throw error;
  } finally {
    await browser.close();
    if (!skipFinalPrepare) {
      const finalPrepare = runPnpmCapture("demo:prepare");
      const finalLink = matchRequired(
        finalPrepare.stdout,
        /Public link:\s+(\S+)/,
        "final public link",
      );
      console.log("");
      console.log(`Entorno limpio listo: ${finalLink}`);
    }
  }

  console.log("");
  console.log("UI demo smoke ok");
}

async function assertDemoLiveKitTarget(meetingCode) {
  if (!expectedLiveKitUrl) return;

  const login = await apiRequest("/api/auth/host/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      identifier: hostIdentifier,
      password: hostPassword,
    }),
  });
  if (!login.response.ok || !login.data.session?.token) {
    fail(
      `No se pudo validar LiveKit del demo: login host HTTP ${login.response.status}`,
    );
  }

  const token = await apiRequest(
    `/api/meetings/${encodeURIComponent(meetingCode)}/join-token`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${login.data.session.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        displayName: "admin",
        camera: true,
        microphone: true,
      }),
    },
  );
  const actualLiveKitUrl = token.data.livekit?.url?.replace(/\/$/, "") ?? null;

  if (actualLiveKitUrl !== expectedLiveKitUrl) {
    fail(
      `Admin emite LIVEKIT_URL=${actualLiveKitUrl ?? "sin configurar"}; el demo espera ${expectedLiveKitUrl}. Ejecuta pnpm demo:up para recrear el admin local.`,
    );
  }
}

async function enterGuestWaitingRoom(page, publicLink, meetingCode) {
  await page.goto(publicLink, { waitUntil: "domcontentloaded" });
  await expectVisibleText(page, meetingCode);
  await page.getByLabel("Nombre visible").fill(guestName);
  await clickByRole(page, "button", "Probar equipo");
  await expectVisibleText(page, "Revisa cámara y micrófono");
  await clickByRole(page, "button", "Entrar como invitado");
  await expectVisibleText(page, "Esperando admisión", 20_000);
}

async function enterHostCall(page, meetingCode) {
  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  await clickByRole(page, "button", "Iniciar sesión como host");
  await page.getByLabel("Correo o usuario").fill(hostIdentifier);
  await page.getByLabel("Contraseña").fill(hostPassword);
  await clickByRole(page, "button", "Continuar");
  await expectVisibleText(page, "Reuniones agendadas", 20_000);
  await page.getByRole("button", { name: new RegExp(meetingCode) }).click();
  await expectVisibleText(page, "Copiar enlace");
  await clickByRole(page, "button", "Probar equipo");
  await expectVisibleText(page, "Revisa cámara y micrófono");
  await enableControlButton(page, "Micrófono");
  await clickByRole(page, "button", "Configurar como host");
  await expectVisibleText(page, "Ajustes de cámara e identidad");
  await expectVisibleText(page, "Identidad principal");
  await expectSelectValue(page, "Identidad", /.+/);
  await enableToggleRow(page, "Activar voz configurada");
  await openDetailsByTestId(page, "host-setup-diagnostics");
  await clickByRole(page, "button", "Runtime IA local");
  await expectVisibleText(page, "Runtime IA local");
  await expectVisibleText(page, "Variables");
  await expectVisibleText(page, "Sidecar");
  await expectVisibleText(page, "Operación");
  await expectVisibleText(page, "Log sidecar");
  await expectVisibleText(page, "Log endpoints");
  await expectVisibleText(page, "Cargar preset");
  await expectVisibleText(page, "Probar IA");
  await clickByRole(page, "button", "Probar IA");
  await expectAnyVisibleText(
    page,
    ["Prueba IA completada.", "Prueba IA completada con avisos."],
    20_000,
  );
  await clickByRole(page, "button", "Volver");
  await expectVisibleText(page, "Ajustes de cámara e identidad");
  await clickByRole(page, "button", "Entrar a la reunión");
  await expectVisibleText(page, "Captura fondo limpio", 15_000);
  await clickByRole(page, "button", "Capturar fondo", 15_000);
  await clickByRole(page, "button", "Continuar", 15_000);
  await expectVisibleText(page, "Ajustes de cámara e identidad", 15_000);
  await openDetailsByTestId(page, "host-setup-diagnostics");
  await expectTestIdText(page, "host-ai-preflight-status", "Pendiente");
  await page.getByTestId("host-enter-meeting").click();
  await expectVisibleText(page, meetingCode, 20_000);
  await expectVisibleText(page, guestName, 20_000);
}

async function assertHostAiVideoBridge(page) {
  await clickByRole(page, "button", "Más", 20_000);
  await expectVisibleText(page, "Diagnóstico", 10_000);
  await page.getByTestId("call-diagnostics").waitFor({
    state: "visible",
    timeout: 10_000,
  });
  await expectTestIdText(page, "call-ai-preflight-status", /passed|warning/);
  await expectVisibleText(page, "Track IA publicado", 30_000);
  await expectProcessedPrimaryVideo(page);
}

async function assertHostAiAudioBridge(page) {
  await expectAnyVisibleText(
    page,
    ["Track voz publicado", "Bridge voz"],
    30_000,
  );
}

async function admitGuest(hostPage, guestPage) {
  await clickByRole(hostPage, "button", "Admitir", 20_000);
  await expectVisibleText(guestPage, "Admitido por el host", 20_000);
}

async function guestJoinsCall(page, meetingCode) {
  await clickByRole(page, "button", "Entrar a la reunión", 20_000);
  await expectVisibleText(page, meetingCode, 20_000);
}

async function assertGuestReceivesHostAiVideo(page) {
  await expectProcessedVideoElement(
    page,
    "remote-host-video-element",
    30_000,
    "El invitado no recibió el video procesado del host",
  );
}

async function assertGuestReceivesHostAudio(page, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let lastSample = null;
  const audio = page.getByTestId("remote-host-audio-element").first();

  await audio.waitFor({ state: "attached", timeout });

  while (Date.now() < deadline) {
    lastSample = await sampleRemoteAudio(page, "remote-host-audio-element");
    if (lastSample.liveTrackCount > 0) return;
    await page.waitForTimeout(500);
  }

  throw new Error(
    `El invitado no recibió audio remoto vivo del host. Última muestra: ${JSON.stringify(lastSample)}`,
  );
}

async function enableControlButton(page, name) {
  const button = page.getByRole("button", { name }).first();
  await button.waitFor({ state: "visible", timeout: 10_000 });
  const active = await button.evaluate((element) =>
    element.classList.contains("active"),
  );
  if (!active) await button.click();
}

async function enableToggleRow(page, name) {
  const button = page.getByRole("button", { name }).first();
  await button.waitFor({ state: "visible", timeout: 10_000 });
  const active = await button.evaluate((element) =>
    Boolean(element.querySelector(".toggle.checked")),
  );
  if (!active) await button.click();
}

async function clickByRole(page, role, name, timeout = 10_000) {
  await page.getByRole(role, { name }).click({ timeout });
}

async function expectVisibleText(page, text, timeout = 10_000) {
  await page
    .getByText(text, { exact: false })
    .first()
    .waitFor({ state: "visible", timeout });
}

async function expectAnyVisibleText(page, texts, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  let lastError;

  while (Date.now() < deadline) {
    for (const text of texts) {
      try {
        await page
          .getByText(text, { exact: false })
          .first()
          .waitFor({ state: "visible", timeout: 500 });
        return;
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw lastError ?? new Error(`Expected one of: ${texts.join(", ")}`);
}

async function expectTestIdText(page, testId, expected, timeout = 10_000) {
  const locator = page.getByTestId(testId);
  await locator.waitFor({ state: "visible", timeout });
  const deadline = Date.now() + timeout;
  let lastText = "";

  while (Date.now() < deadline) {
    lastText = ((await locator.textContent()) ?? "").trim();
    if (
      expected instanceof RegExp
        ? expected.test(lastText)
        : lastText.includes(expected)
    ) {
      return;
    }
    await page.waitForTimeout(250);
  }

  throw new Error(
    `Expected ${testId} to include ${expected}; last text was: ${lastText}`,
  );
}

async function expectSelectValue(page, label, expected, timeout = 10_000) {
  const locator = page.getByLabel(label);
  await locator.waitFor({ state: "visible", timeout });
  const value = await locator.inputValue();
  if (expected instanceof RegExp ? expected.test(value) : value === expected) {
    return;
  }
  fail(`Expected ${label} select value to match ${expected}; got: ${value}`);
}

async function openDetailsByTestId(page, testId) {
  const details = page.getByTestId(testId);
  await details.waitFor({ state: "visible", timeout: 10_000 });
  const isOpen = await details.evaluate((element) => element.open);
  if (!isOpen) await details.locator("summary").click();
}

async function expectProcessedPrimaryVideo(
  page,
  timeout = 30_000,
  failurePrefix = "El video primario no mostró frames procesados por IA",
) {
  return expectProcessedVideoElement(
    page,
    "primary-video-element",
    timeout,
    failurePrefix,
  );
}

async function expectProcessedVideoElement(
  page,
  testId,
  timeout = 30_000,
  failurePrefix = "El video no mostró frames procesados por IA",
) {
  const deadline = Date.now() + timeout;
  let lastSample = null;

  await page.getByTestId(testId).waitFor({ state: "visible", timeout });

  while (Date.now() < deadline) {
    lastSample = await sampleVideo(page, testId);
    if (
      lastSample.readyState >= 2 &&
      lastSample.width > 0 &&
      lastSample.height > 0 &&
      lastSample.greenRatio >= 0.1
    ) {
      return;
    }
    await page.waitForTimeout(500);
  }

  throw new Error(
    `${failurePrefix}. Última muestra: ${JSON.stringify(lastSample)}`,
  );
}

async function samplePrimaryVideo(page) {
  return sampleVideo(page, "primary-video-element");
}

async function sampleVideo(page, testId) {
  return page.getByTestId(testId).evaluate((video) => {
    const width = 160;
    const height = 90;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });

    if (!context || video.readyState < 2 || !video.videoWidth) {
      return {
        readyState: video.readyState,
        width: video.videoWidth,
        height: video.videoHeight,
        greenRatio: 0,
      };
    }

    context.drawImage(video, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    let greenPixels = 0;

    for (let index = 0; index < pixels.length; index += 4) {
      const red = pixels[index] ?? 0;
      const green = pixels[index + 1] ?? 0;
      const blue = pixels[index + 2] ?? 0;
      if (green > 120 && green > red * 1.25 && green > blue * 1.25) {
        greenPixels += 1;
      }
    }

    return {
      readyState: video.readyState,
      width: video.videoWidth,
      height: video.videoHeight,
      greenRatio: greenPixels / (width * height),
    };
  });
}

async function sampleRemoteAudio(page, testId = "remote-audio-element") {
  return page
    .getByTestId(testId)
    .first()
    .evaluate((audio) => {
      const stream =
        audio.srcObject instanceof MediaStream ? audio.srcObject : null;
      const tracks = stream ? stream.getAudioTracks() : [];

      return {
        currentTime: audio.currentTime,
        muted: audio.muted,
        paused: audio.paused,
        readyState: audio.readyState,
        trackCount: tracks.length,
        liveTrackCount: tracks.filter((track) => track.readyState === "live")
          .length,
        tracks: tracks.map((track) => ({
          enabled: track.enabled,
          muted: track.muted,
          readyState: track.readyState,
        })),
      };
    });
}

async function apiRequest(path, init = {}) {
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

async function assertReachableApp() {
  try {
    const response = await fetch(appUrl);
    if (response.ok) return;
    fail(`desktop web returned HTTP ${response.status} at ${appUrl}`);
  } catch (error) {
    fail(
      `desktop web is not reachable at ${appUrl}. Start it with: pnpm --filter @shape-meet/desktop dev:vite\n${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function runPnpmCapture(script) {
  console.log("");
  console.log(`> pnpm ${script}`);
  const result = spawnSync(pnpmCommand(), [script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) fail(`pnpm ${script} failed: ${result.error.message}`);
  if (result.status !== 0) fail(`pnpm ${script} exited with ${result.status}`);

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function matchRequired(value, pattern, label) {
  const match = value.match(pattern);
  if (!match?.[1]) fail(`Could not read ${label} from demo:prepare output.`);
  return match[1];
}

async function captureFailure(page, label) {
  const file = resolve("output", "playwright", `demo-ui-${label}-failure.png`);
  try {
    mkdirSync(dirname(file), { recursive: true });
    await page.screenshot({ path: file, fullPage: true });
    console.error(`Saved ${label} failure screenshot: ${file}`);
  } catch (error) {
    console.error(
      `Could not capture ${label} failure screenshot: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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

function fail(message) {
  console.error(message);
  process.exit(1);
}
