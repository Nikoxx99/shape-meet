import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const releaseDir = join(
  repoRoot,
  "apps",
  "desktop",
  "src-tauri",
  "target",
  "release",
);
const issues = [];
const warnings = [];
const checks = [];
const wrapperFiles = [
  "shape_wrapper_common.py",
  "facefusion_frame.py",
  "backgroundmattingv2_frame.py",
  "vcclient000_chunk.py",
];

main();

function main() {
  if (process.platform === "darwin") {
    checkMacBundle();
  } else if (process.platform === "win32") {
    checkWindowsBundle();
  } else {
    checkGenericBundle();
  }

  printReport();
  if (issues.length > 0) process.exit(1);
}

function checkMacBundle() {
  const appDir = join(releaseDir, "bundle", "macos", "Shape Meet.app");
  const macosDir = join(appDir, "Contents", "MacOS");
  const infoPlist = join(appDir, "Contents", "Info.plist");

  requireDir(appDir, "macOS app bundle");
  requireFile(join(macosDir, "shape-meet"), "app executable");
  requireFile(join(macosDir, "shape-ai-sidecar"), "bundled AI sidecar");
  requireFile(join(macosDir, "shape-ai-processor"), "bundled AI processor");
  requireExecutable(join(macosDir, "shape-meet"), "app executable");
  requireExecutable(join(macosDir, "shape-ai-sidecar"), "bundled AI sidecar");
  requireExecutable(
    join(macosDir, "shape-ai-processor"),
    "bundled AI processor",
  );
  requireBundledWrapperResources([
    join(appDir, "Contents", "Resources", "resources", "ai-wrappers"),
    join(appDir, "Contents", "Resources", "ai-wrappers"),
  ]);
  requireBundledRuntimeConfig([
    join(appDir, "Contents", "Resources", "resources", "shape-meet.env"),
    join(appDir, "Contents", "Resources", "shape-meet.env"),
  ]);
  checkMacInfoPlist(infoPlist);
  requireAnyFile(
    join(releaseDir, "bundle", "dmg"),
    (name) => /^Shape Meet_.*\.dmg$/.test(name),
    "macOS DMG installer",
  );
}

function checkWindowsBundle() {
  requireFile(join(releaseDir, "shape-meet.exe"), "Windows app executable");
  requireFile(join(releaseDir, "shape-ai-sidecar.exe"), "Windows AI sidecar");
  requireFile(
    join(releaseDir, "shape-ai-processor.exe"),
    "Windows AI processor",
  );
  requireBundledWrapperResources([
    join(releaseDir, "resources", "ai-wrappers"),
    join(releaseDir, "ai-wrappers"),
  ]);
  requireBundledRuntimeConfig([
    join(releaseDir, "resources", "shape-meet.env"),
    join(releaseDir, "shape-meet.env"),
  ]);
  requireAnyFile(
    join(releaseDir, "bundle"),
    (name) => /\.(msi|exe)$/.test(name),
    "Windows installer",
    { recursive: true },
  );
}

function checkGenericBundle() {
  requireFile(join(releaseDir, "shape-meet"), "desktop executable");
  requireBundledWrapperResources([
    join(releaseDir, "resources", "ai-wrappers"),
    join(releaseDir, "ai-wrappers"),
  ]);
  requireBundledRuntimeConfig([
    join(releaseDir, "resources", "shape-meet.env"),
    join(releaseDir, "shape-meet.env"),
  ]);
  requireAnyFile(
    join(releaseDir, "bundle"),
    (name) => /shape|meet/i.test(name),
    "desktop bundle artifact",
    { recursive: true },
  );
}

function requireBundledWrapperResources(candidateDirs) {
  const directMatch = candidateDirs.find((dir) =>
    wrapperFiles.every((file) => existsSync(join(dir, file))),
  );
  if (directMatch) {
    ok(`wrappers IA empaquetados: ${relative(directMatch)}`);
    return;
  }

  for (const file of wrapperFiles) {
    requireAnyFile(
      releaseDir,
      (name, path) => name === file && path.includes("ai-wrappers"),
      `wrapper IA ${file}`,
      { recursive: true },
    );
  }
}

function requireBundledRuntimeConfig(candidateFiles) {
  const match = candidateFiles.find((path) => existsSync(path));
  if (!match) {
    fail(
      `No se encontró runtime config desktop embebido: ${candidateFiles
        .map(relative)
        .join(" o ")}`,
    );
    return;
  }

  ok(`runtime config desktop embebido: ${relative(match)}`);
}

function checkMacInfoPlist(path) {
  requireFile(path, "Info.plist");
  const result = spawnSync("plutil", ["-convert", "json", "-o", "-", path], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    fail(
      `No se pudo leer Info.plist: ${(result.stderr || result.stdout).trim()}`,
    );
    return;
  }

  let plist;
  try {
    plist = JSON.parse(result.stdout);
  } catch (error) {
    fail(`Info.plist no parsea como JSON: ${error.message}`);
    return;
  }

  if (plist.CFBundleIdentifier !== "agency.luxora.shapemeet") {
    fail("Info.plist no conserva CFBundleIdentifier esperado.");
  }

  const schemes = (plist.CFBundleURLTypes ?? []).flatMap(
    (entry) => entry.CFBundleURLSchemes ?? [],
  );
  for (const scheme of ["shapemeet", "shape-meet"]) {
    if (!schemes.includes(scheme)) {
      fail(`Info.plist no registra deep link ${scheme}://.`);
    }
  }

  ok("Info.plist registra identifier y deep links");
}

function requireFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    fail(`Falta ${label}: ${relative(path)}`);
    return false;
  }

  if (statSync(path).size <= 0) {
    fail(`${label} está vacío: ${relative(path)}`);
    return false;
  }

  ok(`${label}: ${relative(path)}`);
  return true;
}

function requireDir(path, label) {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    fail(`Falta ${label}: ${relative(path)}`);
    return false;
  }

  ok(`${label}: ${relative(path)}`);
  return true;
}

function requireExecutable(path, label) {
  if (!existsSync(path)) return;
  const mode = statSync(path).mode;
  if ((mode & 0o111) === 0) {
    fail(`${label} no tiene bit ejecutable: ${relative(path)}`);
    return;
  }
  ok(`${label} es ejecutable`);
}

function requireAnyFile(path, predicate, label, options = {}) {
  if (!existsSync(path)) {
    fail(`Falta directorio para ${label}: ${relative(path)}`);
    return;
  }

  const match = findFiles(path, options.recursive).find((file) =>
    predicate(file.name, file.path),
  );
  if (!match) {
    fail(`No se encontró ${label} en ${relative(path)}`);
    return;
  }

  ok(`${label}: ${relative(match.path)}`);
}

function findFiles(path, recursive = false) {
  const entries = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const current = join(path, entry.name);
    if (entry.isFile()) entries.push({ name: entry.name, path: current });
    if (recursive && entry.isDirectory())
      entries.push(...findFiles(current, true));
  }
  return entries;
}

function ok(message) {
  checks.push(message);
}

function warn(message) {
  warnings.push(message);
}

function fail(message) {
  issues.push(message);
}

function printReport() {
  console.log("Desktop bundle check");
  for (const check of checks) console.log(`ok: ${check}`);
  for (const warning of warnings) console.warn(`warn: ${warning}`);
  for (const issue of issues) console.error(`fail: ${issue}`);

  if (issues.length === 0) {
    console.log(
      warnings.length > 0
        ? "Desktop bundle check ok con advertencias"
        : "Desktop bundle check ok",
    );
  } else {
    console.error("Desktop bundle check failed");
  }
}

function relative(path) {
  return path.startsWith(repoRoot) ? path.slice(repoRoot.length + 1) : path;
}
