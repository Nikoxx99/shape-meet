import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const args = new Set(process.argv.slice(2));
const strict = args.has("--strict");
const issues = [];
const warnings = [];
const checks = [];
const desktopTauriDir = join(repoRoot, "apps", "desktop", "src-tauri");
const binariesDir = join(desktopTauriDir, "binaries");
const wrappersResourceDir = join(desktopTauriDir, "resources", "ai-wrappers");
const desktopRuntimeConfigResource = join(
  desktopTauriDir,
  "resources",
  "shape-meet.env",
);
const sidecarSource = join(repoRoot, "apps", "ai-sidecar", "server.py");
const processorSource = join(
  repoRoot,
  "apps",
  "ai-sidecar",
  "processors",
  "shape_processor_command.py",
);
const wrapperSources = [
  "shape_wrapper_common.py",
  "facefusion_frame.py",
  "backgroundmattingv2_frame.py",
  "vcclient000_chunk.py",
].map((name) => join(repoRoot, "apps", "ai-sidecar", "wrappers", name));
const tauriConfig = join(desktopTauriDir, "tauri.conf.json");
const sidecarConfig = join(desktopTauriDir, "tauri.sidecar.conf.json");
const rustHostTriple = readRustHostTriple();
const targetTriple = process.env.TAURI_TARGET_TRIPLE || rustHostTriple;
const binarySuffix = process.platform === "win32" ? ".exe" : "";
const expectedSidecar = join(
  binariesDir,
  `shape-ai-sidecar-${targetTriple}${binarySuffix}`,
);
const expectedProcessor = join(
  binariesDir,
  `shape-ai-processor-${targetTriple}${binarySuffix}`,
);

main();

function main() {
  checkRequiredFiles();
  checkToolchain();
  checkPythonSyntax();
  checkTauriConfig();
  checkSidecarConfig();
  checkWrapperResources();
  checkDesktopRuntimeConfigResource();
  checkBuiltSidecars();
  printReport();

  if (issues.length > 0) process.exit(1);
}

function checkRequiredFiles() {
  for (const file of [
    tauriConfig,
    sidecarSource,
    processorSource,
    join(repoRoot, "apps", "ai-sidecar", "requirements-packaging.txt"),
    ...wrapperSources,
  ]) {
    if (!existsSync(file)) {
      fail(`Falta archivo requerido para build desktop: ${relative(file)}`);
    }
  }
  ok("archivos base de desktop/sidecar presentes");
}

function checkToolchain() {
  requireCommand(pnpmCommand(), ["--version"], "pnpm");
  requireCommand("cargo", ["--version"], "cargo");
  requireCommand("rustc", ["-Vv"], "rustc");

  const python = pythonCommand();
  requireCommand(python, ["--version"], "python");
  requireCommand(python, ["-m", "venv", "--help"], "python venv");

  const tauri = spawnCommand(
    pnpmCommand(),
    ["--filter", "@shape-meet/desktop", "exec", "tauri", "--version"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (tauri.status === 0) {
    ok(`Tauri CLI disponible (${firstLine(tauri.stdout || tauri.stderr)})`);
  } else {
    warn(
      "Tauri CLI no respondió. Ejecuta `pnpm install` antes de `pnpm build:desktop`.",
    );
  }

  if (
    process.env.TAURI_TARGET_TRIPLE &&
    process.env.TAURI_TARGET_TRIPLE !== rustHostTriple
  ) {
    const message = `TAURI_TARGET_TRIPLE=${process.env.TAURI_TARGET_TRIPLE} no coincide con rust host ${rustHostTriple}; PyInstaller no hace cross-compile real.`;
    if (strict) fail(message);
    else warn(message);
  }

  ok(`target detectado: ${targetTriple}`);
}

function checkPythonSyntax() {
  const python = pythonCommand();
  const result = spawnSync(
    python,
    ["-m", "py_compile", sidecarSource, processorSource, ...wrapperSources],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    fail(
      `Sintaxis Python inválida:\n${(result.stderr || result.stdout || "").trim()}`,
    );
    return;
  }
  ok("sintaxis Python de sidecar, processor y wrappers");
}

function checkTauriConfig() {
  const config = readJson(tauriConfig);
  if (!config) return;

  if (config.productName !== "Shape Meet") {
    warn("tauri.conf.json no declara productName Shape Meet.");
  }
  if (config.identifier !== "agency.luxora.shapemeet") {
    warn("tauri.conf.json no declara identifier agency.luxora.shapemeet.");
  }
  if (config.bundle?.active !== false) {
    warn(
      "tauri.conf.json base debería mantener bundle.active=false; el build con sidecar usa tauri.sidecar.conf.json.",
    );
  }
  ok("tauri.conf.json parsea correctamente");
}

function checkSidecarConfig() {
  if (!existsSync(sidecarConfig)) {
    const message =
      "tauri.sidecar.conf.json no existe todavía; `pnpm build:ai-sidecar` lo genera.";
    if (strict) fail(message);
    else warn(message);
    return;
  }

  const config = readJson(sidecarConfig);
  if (!config) return;

  const externalBin = config.bundle?.externalBin;
  if (!Array.isArray(externalBin)) {
    fail("tauri.sidecar.conf.json no define bundle.externalBin.");
    return;
  }

  for (const expected of [
    "binaries/shape-ai-sidecar",
    "binaries/shape-ai-processor",
  ]) {
    if (!externalBin.includes(expected)) {
      fail(`tauri.sidecar.conf.json no incluye ${expected}.`);
    }
  }
  const resources = config.bundle?.resources;
  if (!Array.isArray(resources)) {
    fail("tauri.sidecar.conf.json no define bundle.resources.");
    return;
  }
  for (const expected of [
    "resources/ai-wrappers",
    "resources/shape-meet.env",
  ]) {
    if (!resources.includes(expected)) {
      const message = `tauri.sidecar.conf.json no incluye ${expected}. Ejecuta pnpm build:ai-sidecar.`;
      if (strict) fail(message);
      else warn(message);
    }
  }
  if (
    resources.includes("resources/ai-wrappers") &&
    resources.includes("resources/shape-meet.env")
  ) {
    ok("tauri.sidecar.conf.json incluye sidecar, processor y runtime config");
    return;
  }
}

function checkWrapperResources() {
  for (const source of wrapperSources) {
    const target = join(wrappersResourceDir, source.split(/[/\\]/).pop());
    if (!existsSync(target)) {
      const message = `Wrapper no copiado a recursos desktop: ${relative(target)}. Ejecuta pnpm build:ai-sidecar.`;
      if (strict) fail(message);
      else warn(message);
      continue;
    }

    const sourceStat = statSync(source);
    const targetStat = statSync(target);
    if (targetStat.size <= 0) {
      fail(`Wrapper de recurso vacío: ${relative(target)}`);
      continue;
    }
    if (targetStat.mtimeMs < sourceStat.mtimeMs) {
      const message = `Wrapper de recurso desactualizado frente a ${relative(source)}. Ejecuta pnpm build:ai-sidecar.`;
      if (strict) fail(message);
      else warn(message);
    }
  }
  ok("wrappers IA configurados como recursos desktop");
}

function checkDesktopRuntimeConfigResource() {
  if (!existsSync(desktopRuntimeConfigResource)) {
    const message =
      "Runtime config desktop no está embebido: apps/desktop/src-tauri/resources/shape-meet.env. Ejecuta pnpm build:ai-sidecar o descarga shape-meet-runtime-config.";
    if (strict) fail(message);
    else warn(message);
    return;
  }

  const content = readFileSync(desktopRuntimeConfigResource, "utf8");
  for (const key of [
    "SHAPE_API_URL=",
    "SHAPE_MEETING_URL=",
    "SHAPE_AI_SERVICE_URL=",
  ]) {
    if (!content.includes(key)) {
      fail(`Runtime config desktop no incluye ${key.slice(0, -1)}.`);
    }
  }
  ok("runtime config desktop embebido");
}

function checkBuiltSidecars() {
  checkBuiltBinary(expectedSidecar, sidecarSource, "sidecar");
  checkBuiltBinary(expectedProcessor, processorSource, "processor");
}

function checkBuiltBinary(binaryPath, sourcePath, label) {
  if (!existsSync(binaryPath)) {
    const message = `Binario ${label} no existe para ${targetTriple}: ${relative(binaryPath)}. Ejecuta pnpm build:ai-sidecar.`;
    if (strict) fail(message);
    else warn(message);
    return;
  }

  const binaryStat = statSync(binaryPath);
  const sourceStat = statSync(sourcePath);
  if (binaryStat.size <= 0) {
    fail(`Binario ${label} vacío: ${relative(binaryPath)}`);
    return;
  }

  if (binaryStat.mtimeMs < sourceStat.mtimeMs) {
    const message = `Binario ${label} parece desactualizado frente a ${relative(sourcePath)}. Ejecuta pnpm build:ai-sidecar.`;
    if (strict) fail(message);
    else warn(message);
    return;
  }

  ok(`${label} empaquetado para ${targetTriple}`);
}

function requireCommand(command, commandArgs, label) {
  const result = spawnCommand(command, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const details =
      result.stderr || result.stdout || result.error?.message || "sin salida";
    fail(`${label} no disponible: ${String(details).trim()}`);
    return null;
  }
  ok(`${label} disponible (${firstLine(result.stdout || result.stderr)})`);
  return result.stdout;
}

function spawnCommand(command, commandArgs, options) {
  return spawnSync(command, commandArgs, {
    ...options,
    shell: process.platform === "win32" && /\.cmd$/i.test(command),
  });
}

function readRustHostTriple() {
  const result = spawnSync("rustc", ["-Vv"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) return "unknown";

  const hostLine = result.stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith("host: "));
  return hostLine?.slice("host: ".length).trim() || "unknown";
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${relative(path)} no parsea como JSON: ${error.message}`);
    return null;
  }
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
  console.log("Desktop release doctor");
  for (const check of checks) console.log(`ok: ${check}`);
  for (const warning of warnings) console.warn(`warn: ${warning}`);
  for (const issue of issues) console.error(`fail: ${issue}`);

  if (issues.length === 0) {
    console.log(
      warnings.length > 0
        ? "Desktop release doctor ok con advertencias"
        : "Desktop release doctor ok",
    );
  } else {
    console.error("Desktop release doctor failed");
  }
}

function relative(path) {
  return path.startsWith(repoRoot) ? path.slice(repoRoot.length + 1) : path;
}

function firstLine(value) {
  return (
    String(value || "")
      .split(/\r?\n/)
      .find(Boolean)
      ?.trim() || "ok"
  );
}

function pythonCommand() {
  return (
    process.env.SHAPE_AI_PYTHON ||
    (process.platform === "win32" ? "python" : "python3")
  );
}

function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}
