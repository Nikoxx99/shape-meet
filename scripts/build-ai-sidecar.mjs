import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const desktopTauriDir = join(repoRoot, "apps", "desktop", "src-tauri");
const sidecarSource = join(repoRoot, "apps", "ai-sidecar", "server.py");
const processorSource = join(repoRoot, "apps", "ai-sidecar", "processors", "shape_processor_command.py");
const requirementsFile = join(repoRoot, "apps", "ai-sidecar", "requirements-packaging.txt");
const binariesDir = join(desktopTauriDir, "binaries");
const outputDir = join(repoRoot, "output", "ai-sidecar-build");
const venvDir = join(outputDir, "venv");
const targetTriple = process.env.TAURI_TARGET_TRIPLE || readRustHostTriple();
const binaryBaseName = "shape-ai-sidecar";
const processorBaseName = "shape-ai-processor";
const targetBinaryName = `${binaryBaseName}-${targetTriple}${process.platform === "win32" ? ".exe" : ""}`;
const targetProcessorName = `${processorBaseName}-${targetTriple}${process.platform === "win32" ? ".exe" : ""}`;
const targetBinaryPath = join(binariesDir, targetBinaryName);
const targetProcessorPath = join(binariesDir, targetProcessorName);
const configPath = join(desktopTauriDir, "tauri.sidecar.conf.json");

ensureFile(sidecarSource);
ensureFile(processorSource);
ensureFile(requirementsFile);
mkdirSync(binariesDir, { recursive: true });
mkdirSync(outputDir, { recursive: true });

ensureVenv();
const python = venvPython();
installPackagingRequirements(python);
buildPyInstallerBinary(python, sidecarSource, targetBinaryName, targetBinaryPath, "construir sidecar PyInstaller");
buildPyInstallerBinary(python, processorSource, targetProcessorName, targetProcessorPath, "construir procesador IA PyInstaller");
writeTauriSidecarConfig();

console.log(`AI sidecar listo: ${targetBinaryPath}`);
console.log(`AI processor listo: ${targetProcessorPath}`);
console.log(`Config Tauri temporal: ${configPath}`);

function ensureVenv() {
  if (existsSync(pythonPathForVenv())) return;

  run(pythonCommand(), ["-m", "venv", venvDir], {
    cwd: repoRoot,
    label: "crear venv de empaquetado"
  });
}

function installPackagingRequirements(python) {
  run(python, ["-m", "pip", "install", "--upgrade", "pip"], {
    cwd: repoRoot,
    label: "actualizar pip del venv"
  });
  run(python, ["-m", "pip", "install", "-r", requirementsFile], {
    cwd: repoRoot,
    label: "instalar PyInstaller"
  });
}

function buildPyInstallerBinary(python, source, targetName, targetPath, label) {
  rmSync(targetPath, { force: true });
  run(
    python,
    [
      "-m",
      "PyInstaller",
      "--onefile",
      "--clean",
      "--noconfirm",
      "--name",
      targetName.replace(/\.exe$/, ""),
      "--distpath",
      binariesDir,
      "--workpath",
      join(outputDir, "pyinstaller-work"),
      "--specpath",
      join(outputDir, "pyinstaller-spec"),
      source
    ],
    {
      cwd: repoRoot,
      label
    }
  );

  if (!existsSync(targetPath)) {
    throw new Error(`PyInstaller terminó sin crear ${targetPath}`);
  }
}

function writeTauriSidecarConfig() {
  const config = {
    bundle: {
      active: true,
      targets: "all",
      icon: [
        "icons/32x32.png",
        "icons/128x128.png",
        "icons/128x128@2x.png",
        "icons/icon.icns",
        "icons/icon.ico"
      ],
      externalBin: [`binaries/${binaryBaseName}`, `binaries/${processorBaseName}`]
    }
  };

  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function readRustHostTriple() {
  const result = spawnSync("rustc", ["-Vv"], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  if (result.status !== 0) {
    throw new Error(`No se pudo consultar rustc -Vv: ${result.stderr || result.stdout}`);
  }

  const hostLine = result.stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith("host: "));
  const host = hostLine?.slice("host: ".length).trim();

  if (!host) {
    throw new Error("rustc -Vv no devolvió target host.");
  }

  return host;
}

function pythonCommand() {
  return process.env.SHAPE_AI_PYTHON || (process.platform === "win32" ? "python" : "python3");
}

function venvPython() {
  return pythonPathForVenv();
}

function pythonPathForVenv() {
  return process.platform === "win32"
    ? join(venvDir, "Scripts", "python.exe")
    : join(venvDir, "bin", "python");
}

function ensureFile(path) {
  if (!existsSync(path)) {
    throw new Error(`No existe ${path}`);
  }

  readFileSync(path);
}

function run(command, args, { cwd, label }) {
  console.log(`> ${label}`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env
  });

  if (result.status !== 0) {
    throw new Error(`${label} falló con código ${result.status ?? "desconocido"}`);
  }
}
