import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright";

const args = new Set(process.argv.slice(2));
const headed = args.has("--headed");
const appPort = Number(argValue("--app-port") ?? 0) || (await getFreePort());
const aiPort = Number(argValue("--ai-port") ?? 0) || (await getFreePort());
const videoPort =
  Number(argValue("--video-port") ?? 0) || (await getFreePort());
const audioPort =
  Number(argValue("--audio-port") ?? 0) || (await getFreePort());
const appUrl = `http://127.0.0.1:${appPort}`;
const aiUrl = `http://127.0.0.1:${aiPort}`;
const children = [];

await main().finally(async () => {
  await stopChildren();
});

async function main() {
  startAiSidecar();
  startDesktopWeb();

  await waitForJson(`${aiUrl}/health`, (data) => data.status === "ready", {
    label: "AI sidecar",
    timeoutMs: 45_000,
  });
  await waitForJson(`${aiUrl}/health`, hasIsolatedDemoProcessors, {
    label: "AI demo processors",
    timeoutMs: 45_000,
  });
  await waitForHttp(appUrl, { label: "desktop web", timeoutMs: 45_000 });

  const browser = await chromium.launch({
    headless: !headed,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--no-sandbox",
    ],
  });
  const context = await browser.newContext({
    permissions: ["camera", "microphone"],
  });
  const page = await context.newPage();

  try {
    await enterDemoHostCall(page);
    const sample = await expectProcessedPrimaryVideo(page);
    await clickByRole(page, "button", "Más", 15_000);
    await expectVisibleText(page, "Track IA publicado", 30_000);
    await expectVisibleText(page, "Runtime IA", 30_000);
    await expectVisibleText(page, "Bundle debug", 30_000);
    await expectVisibleText(page, "Evento Sentry", 30_000);
    await expectTestIdText(page, "call-ai-preflight-status", /passed|warning/);
    await expectVisibleText(page, "Bridge voz", 30_000);
    console.log(
      `local AI preview smoke ok: video=${JSON.stringify(sample)} voice=bridge`,
    );
  } catch (error) {
    await captureFailure(page, "local-ai-preview");
    throw error;
  } finally {
    await browser.close();
  }
}

function startAiSidecar() {
  const child = spawn(
    process.execPath,
    [
      "scripts/run-demo-ai-sidecar.mjs",
      "--port",
      String(aiPort),
      "--video-port",
      String(videoPort),
      "--audio-port",
      String(audioPort),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SENTRY_DSN: "",
        VITE_SENTRY_DSN: "",
        NEXT_PUBLIC_SENTRY_DSN: "",
        SHAPE_AI_DEV_VENV: "0",
        SHAPE_AI_PORT: String(aiPort),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  pipeChildOutput("ai", child);
  children.push({ label: "AI sidecar", child });
}

function hasIsolatedDemoProcessors(data) {
  const processors = data.diagnostics?.managedProcessors ?? [];
  const video = processors.find((processor) => processor.id === "video");
  const audio = processors.find((processor) => processor.id === "audio");

  return (
    data.status === "ready" &&
    video?.status === "running" &&
    video?.endpoint === `http://127.0.0.1:${videoPort}/process-frame` &&
    audio?.status === "running" &&
    audio?.endpoint === `http://127.0.0.1:${audioPort}/process-audio`
  );
}

function startDesktopWeb() {
  const child = spawn(
    pnpmCommand(),
    [
      "--filter",
      "@shape-meet/desktop",
      "exec",
      "vite",
      "--host",
      "127.0.0.1",
      "--port",
      String(appPort),
      "--strictPort",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SENTRY_DSN: "",
        VITE_SENTRY_DSN: "",
        VITE_SHAPE_API_URL: "http://127.0.0.1:9",
        VITE_SHAPE_AI_SERVICE_URL: aiUrl,
        VITE_SHAPE_DEMO_DATA: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  pipeChildOutput("web", child);
  children.push({ label: "Desktop web", child });
}

async function enterDemoHostCall(page) {
  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  await clickByRole(page, "button", "Iniciar sesión como host");
  await page.getByLabel("Correo o usuario").fill("admin@shape.test");
  await page.getByLabel("Contraseña").fill("ChangeMe123!");
  await clickByRole(page, "button", "Continuar");
  await expectVisibleText(page, "Confirma que eres host", 15_000);

  for (let index = 1; index <= 6; index += 1) {
    await page.getByLabel(`Dígito ${index}`).fill(String(index));
  }

  await clickByRole(page, "button", "Verificar y continuar");
  await expectVisibleText(page, "Reuniones agendadas", 15_000);
  await page
    .getByRole("button", { name: /SM-\d{3}-\d{3}/ })
    .first()
    .click();
  await expectVisibleText(page, "Copiar enlace");
  await clickByRole(page, "button", "Probar equipo");
  await expectVisibleText(page, "Revisa cámara y micrófono");
  await clickByRole(page, "button", "Entrar con micrófono apagado");
  await clickByRole(page, "button", "Configurar como host");
  await expectVisibleText(page, "Ajustes de cámara e identidad");
  await clickByRole(page, "button", "Activar voz configurada");
  await clickByRole(page, "button", "Entrar a la reunión");
  await expectVisibleText(page, "Captura fondo limpio", 15_000);
  await clickByRole(page, "button", "Capturar fondo", 15_000);
  await clickByRole(page, "button", "Continuar", 15_000);
  await expectVisibleText(page, "Ajustes de cámara e identidad", 15_000);
  await openDetailsByTestId(page, "host-setup-diagnostics");
  await expectTestIdText(page, "host-ai-preflight-status", "Pendiente");
  await page.getByTestId("host-enter-meeting").click();
  await expectVisibleText(page, "1 participante", 15_000);
}

async function expectProcessedPrimaryVideo(page, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let lastSample = null;

  await page
    .getByTestId("primary-video-element")
    .waitFor({ state: "visible", timeout });

  while (Date.now() < deadline) {
    lastSample = await samplePrimaryVideo(page);
    if (
      lastSample.readyState >= 2 &&
      lastSample.width > 0 &&
      lastSample.height > 0 &&
      lastSample.greenRatio >= 0.1
    ) {
      return lastSample;
    }
    await page.waitForTimeout(500);
  }

  throw new Error(
    `Primary video did not show processed AI frames. Last sample: ${JSON.stringify(lastSample)}`,
  );
}

async function samplePrimaryVideo(page) {
  return page.getByTestId("primary-video-element").evaluate((video) => {
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

async function clickByRole(page, role, name, timeout = 10_000) {
  await page.getByRole(role, { name }).click({ timeout });
}

async function expectVisibleText(page, text, timeout = 10_000) {
  await page
    .getByText(text, { exact: false })
    .first()
    .waitFor({ state: "visible", timeout });
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

async function openDetailsByTestId(page, testId) {
  const details = page.getByTestId(testId);
  await details.waitFor({ state: "visible", timeout: 10_000 });
  const isOpen = await details.evaluate((element) => element.open);
  if (!isOpen) await details.locator("summary").click();
}

async function waitForHttp(url, { label, timeoutMs }) {
  await waitFor(label, timeoutMs, async () => {
    const response = await fetch(url).catch(() => null);
    return Boolean(response?.ok);
  });
}

async function waitForJson(url, predicate, { label, timeoutMs }) {
  await waitFor(label, timeoutMs, async () => {
    const response = await fetch(url).catch(() => null);
    if (!response?.ok) return false;
    const data = await response.json().catch(() => null);
    return Boolean(data && predicate(data));
  });
}

async function waitFor(label, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} did not become ready within ${timeoutMs}ms.`);
}

function pipeChildOutput(label, child) {
  child.stdout?.on("data", (chunk) => {
    const text = String(chunk).trimEnd();
    if (text) console.log(`[${label}] ${text}`);
  });
  child.stderr?.on("data", (chunk) => {
    const text = String(chunk).trimEnd();
    if (text) console.error(`[${label}] ${text}`);
  });
}

async function stopChildren() {
  await Promise.all(
    children.reverse().map(
      ({ child }) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode) {
            resolve();
            return;
          }

          const forceTimer = setTimeout(() => {
            if (child.exitCode === null) child.kill("SIGTERM");
          }, 2500);
          child.once("exit", () => {
            clearTimeout(forceTimer);
            resolve();
          });
          child.kill("SIGINT");
        }),
    ),
  );
}

async function captureFailure(page, label) {
  const file = resolve("output", "playwright", `${label}-failure.png`);
  try {
    mkdirSync(dirname(file), { recursive: true });
    await page.screenshot({ path: file, fullPage: true });
    console.error(`Saved failure screenshot: ${file}`);
  } catch (error) {
    console.error(
      `Could not capture screenshot: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
          return;
        }
        reject(new Error("Could not allocate a free local port."));
      });
    });
  });
}

function argValue(name) {
  const argv = process.argv.slice(2);
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  if (index !== -1) return argv[index + 1];
  return null;
}

function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}
