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
const hostIdentifier =
  process.env.SHAPE_DEMO_HOST_IDENTIFIER ??
  readEnvFileValue("apps/desktop/.env.local", "VITE_SHAPE_HOST_IDENTIFIER") ??
  readEnvFileValue("apps/admin/.env.local", "HOST_BOOTSTRAP_EMAIL") ??
  "admin@shape.test";
const hostPassword =
  process.env.SHAPE_DEMO_HOST_PASSWORD ??
  readEnvFileValue("apps/admin/.env.local", "HOST_BOOTSTRAP_PASSWORD") ??
  "ChangeMe123!";
const guestName = process.env.SHAPE_DEMO_GUEST_NAME ?? "Invitada Demo";

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
    await admitGuest(hostPage, guestPage);
    await guestJoinsCall(guestPage, meetingCode);
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
      console.log(`Demo limpio listo: ${finalLink}`);
    }
  }

  console.log("");
  console.log("UI demo smoke ok");
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
  await expectVisibleText(page, "Confirma que eres host");

  for (let index = 1; index <= 6; index += 1) {
    await page.getByLabel(`Dígito ${index}`).fill(String(index));
  }

  await clickByRole(page, "button", "Verificar y continuar");
  await expectVisibleText(page, "Reuniones agendadas", 20_000);
  await page.getByRole("button", { name: new RegExp(meetingCode) }).click();
  await expectVisibleText(page, "Copiar enlace");
  await clickByRole(page, "button", "Probar equipo");
  await expectVisibleText(page, "Revisa cámara y micrófono");
  await clickByRole(page, "button", "Configurar como host");
  await expectVisibleText(page, "Ajustes de cámara e identidad");
  await expectVisibleText(page, "Rostro demo aprobado");
  await clickByRole(page, "button", "Entrar a la reunión");
  await expectVisibleText(page, meetingCode, 20_000);
  await expectVisibleText(page, guestName, 20_000);
}

async function admitGuest(hostPage, guestPage) {
  await clickByRole(hostPage, "button", "Admitir", 20_000);
  await expectVisibleText(guestPage, "Admitido por el host", 20_000);
}

async function guestJoinsCall(page, meetingCode) {
  await clickByRole(page, "button", "Entrar a la reunión", 20_000);
  await expectVisibleText(page, meetingCode, 20_000);
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
