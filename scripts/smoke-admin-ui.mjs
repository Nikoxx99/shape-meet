import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright";

const args = new Set(process.argv.slice(2));
const headed = args.has("--headed");
const adminUrl = (
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

await main();

async function main() {
  await assertReachableAdmin();

  const suffix = Date.now().toString(36);
  const host = {
    username: `smoke_ui_${suffix}`,
    email: `smoke_ui_${suffix}@shape.test`,
    password: "ChangeMe123!",
  };
  const identityName = `Rostro UI ${suffix}`;
  const artifactName = `identity-${suffix}.bin`;

  const browser = await chromium.launch({
    headless: !headed,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();

  try {
    await loginAdmin(page);
    await createHostUser(page, host);
    await createAndPublishIdentity(page, {
      host,
      identityName,
      artifactName,
      artifactPayload: `shape-meet-admin-ui:${suffix}`,
    });
    await verifyDeliveryAndAudit(page, identityName);
  } catch (error) {
    await captureFailure(page);
    throw error;
  } finally {
    await browser.close();
  }

  console.log("");
  console.log(`admin UI smoke ok: ${host.email} / ${identityName}`);
}

async function loginAdmin(page) {
  await page.goto(adminUrl, { waitUntil: "domcontentloaded" });
  await expectVisibleText(page, "Shape Meet Admin");
  await page.getByLabel("Correo o usuario").fill(identifier);
  await page.getByLabel("Clave").fill(password);
  await clickByRole(page, "button", "Entrar");
  await expectVisibleText(page, "Usuarios y hosts", 20_000);
  await expectVisibleText(page, identifier, 20_000);
  console.log(`login ok: ${identifier}`);
}

async function createHostUser(page, host) {
  await clickByRole(page, "button", "Crear usuario");
  const dialog = page.getByRole("dialog", { name: "Crear usuario" });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await inputField(dialog, "Usuario").fill(host.username);
  await inputField(dialog, "Correo").fill(host.email);
  await inputField(dialog, "Clave").fill(host.password);
  await selectField(dialog, "Rango").selectOption("HOST");
  await dialog.getByRole("button", { name: "Crear usuario" }).click();
  await expectVisibleText(page, "Usuario creado.", 20_000);
  await expectVisibleText(page, host.email, 20_000);
  console.log(`host create ok: ${host.email}`);
}

async function createAndPublishIdentity(
  page,
  { host, identityName, artifactName, artifactPayload },
) {
  await clickByRole(page, "button", "Rostros aprobados");
  await expectVisibleText(page, "Rostros aprobados");
  await clickByRole(page, "button", "Agregar rostro");

  const dialog = page.getByRole("dialog", { name: "Agregar rostro" });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await selectField(dialog, "Host").selectOption({
    label: hostOptionLabel(host),
  });
  await inputField(dialog, "Nombre").fill(identityName);
  await selectField(dialog, "Tipo").selectOption("PHOTO_IDENTITY");
  await selectField(dialog, "Estado").selectOption("AVAILABLE");
  await inputField(dialog, "Versión").fill("smoke-ui");
  await fileField(dialog, "Archivo").setInputFiles({
    name: artifactName,
    mimeType: "application/octet-stream",
    buffer: Buffer.from(artifactPayload),
  });
  await dialog.getByRole("button", { name: "Agregar rostro" }).click();
  await expectVisibleText(page, "Rostro agregado.", 20_000);

  const row = identityRow(page, identityName);
  await row.waitFor({ state: "visible", timeout: 20_000 });
  await expectRowText(row, "Listo");
  await row.getByRole("button", { name: "Push" }).click();
  await expectVisibleText(page, "Rostro publicado para el host.", 20_000);
  await expectRowText(row, "Publicado", 20_000);
  console.log(`identity push ok: ${identityName}`);
}

async function verifyDeliveryAndAudit(page, identityName) {
  await clickByRole(page, "button", "Sistema");
  await expectVisibleText(page, identityName, 20_000);
  await expectVisibleText(page, "Publicado", 20_000);

  await clickByRole(page, "button", "Auditoría");
  await expectVisibleText(page, "Identity Pushed", 20_000);
  await expectVisibleText(page, identityName, 20_000);
  console.log("delivery and audit ok");
}

async function assertReachableAdmin() {
  try {
    const response = await fetch(`${adminUrl}/api/health`);
    if (response.ok) return;
    fail(`admin returned HTTP ${response.status} at ${adminUrl}/api/health`);
  } catch (error) {
    fail(
      `admin is not reachable at ${adminUrl}. Start it with: pnpm demo:ready\n${error instanceof Error ? error.message : String(error)}`,
    );
  }
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

async function expectRowText(row, text, timeout = 10_000) {
  await row.getByText(text, { exact: false }).waitFor({
    state: "visible",
    timeout,
  });
}

function identityRow(page, identityName) {
  return page
    .locator(".table-row.identities-table")
    .filter({ hasText: identityName })
    .first();
}

function inputField(root, label) {
  return formField(root, label).locator("input").first();
}

function selectField(root, label) {
  return formField(root, label).locator("select").first();
}

function fileField(root, label) {
  return formField(root, label).locator('input[type="file"]').first();
}

function formField(root, label) {
  return root
    .locator("label.field")
    .filter({ hasText: new RegExp(`^${escapeRegExp(label)}`) })
    .first();
}

function hostOptionLabel(host) {
  return `${host.username} · ${host.email}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function captureFailure(page) {
  const file = resolve("output", "playwright", "admin-ui-failure.png");
  try {
    mkdirSync(dirname(file), { recursive: true });
    await page.screenshot({ path: file, fullPage: true });
    console.error(`Saved admin UI failure screenshot: ${file}`);
  } catch (error) {
    console.error(
      `Could not capture admin UI failure screenshot: ${error instanceof Error ? error.message : String(error)}`,
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

function fail(message) {
  console.error(message);
  process.exit(1);
}
