import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const args = process.argv.slice(2);
const json = args.includes("--json");
const strict = args.includes("--strict");
const dryRun = args.includes("--dry-run");
const initDirs = args.includes("--init-dirs");
const cloneRepos = args.includes("--clone");
const writeRuntime = args.includes("--write-runtime") && !dryRun;
const writeChecklist = args.includes("--write-checklist");
const skipHardware = args.includes("--skip-hardware");
const skipVcclient = args.includes("--skip-vcclient");
const profile = normalizeProfile(
  argValue("--profile") ??
    process.env.SHAPE_MODEL_WORKSTATION_PROFILE ??
    defaultProfile(),
);
const workspaceRoot = argValue("--workspace") ?? defaultWorkspaceRoot(profile);
const runtimeEnvPath =
  argValue("--out") ??
  process.env.SHAPE_AI_RUNTIME_ENV_FILE ??
  defaultRuntimeEnvPath();
const checklistPath =
  argValue("--checklist-out") ??
  process.env.SHAPE_MODEL_WORKSTATION_CHECKLIST ??
  defaultChecklistPath(profile);
const facefusionRepo =
  argValue("--facefusion-repo") ??
  process.env.FACEFUSION_REPO_URL ??
  "https://github.com/facefusion/facefusion.git";
const bmv2Repo =
  argValue("--bmv2-repo") ??
  process.env.BMV2_REPO_URL ??
  "https://github.com/PeterL1n/BackgroundMattingV2.git";
const vcclientEndpoint =
  argValue("--vcclient000-http-endpoint") ??
  process.env.VCCLIENT000_HTTP_ENDPOINT ??
  defaultVcClientEndpoint(profile);
const checks = [];
const nextSteps = [];
let runtimeEnv = {};
let runtimeEnvContent = "";
let tempDir = null;
let checklistWritten = false;

try {
  main();
} finally {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
}

function main() {
  const modelPaths = buildModelPaths(profile, workspaceRoot);

  maybeCreateWorkspace(modelPaths);
  maybeCloneRepo("FaceFusion", facefusionRepo, modelPaths.facefusionDir);
  maybeCloneRepo("BackgroundMattingV2", bmv2Repo, modelPaths.bmv2RepoDir);

  runtimeEnvContent = renderRuntimeEnv(modelPaths);
  runtimeEnv = parseEnv(runtimeEnvContent);

  if (writeRuntime) {
    runPrepareRuntime(modelPaths, false);
    ok("runtime", `Runtime escrito: ${runtimeEnvPath}`);
  } else {
    warn(
      "runtime",
      dryRun
        ? "Dry-run: runtime no escrito."
        : "Runtime no escrito; usa --write-runtime para aplicarlo.",
    );
    nextStep(
      `Escribe runtime: pnpm models:bootstrap -- --profile ${profile} --write-runtime`,
    );
  }

  checkCommand("git", "Git");
  checkCommand(basePythonCommand(), "Python base");
  if (profile === "windows-nvidia" && !skipHardware) checkNvidia();
  checkFaceFusion(modelPaths);
  checkBackgroundMatting(modelPaths);
  if (!skipVcclient) voidCheckVcClient(vcclientEndpoint);

  runDoctor(writeTempRuntimeEnv());
  printReport(modelPaths);

  if (strict && (hasErrors() || hasWarnings())) process.exit(1);
}

function maybeCreateWorkspace(modelPaths) {
  const root = fsPath(modelPaths.workspaceRoot);
  if (!root) {
    warn(
      "workspace",
      `Ruta no verificable en ${platform()}: ${modelPaths.workspaceRoot}`,
    );
    return;
  }

  if (existsSync(root)) {
    ok("workspace", `Workspace disponible: ${modelPaths.workspaceRoot}`);
    return;
  }

  if (!initDirs || dryRun) {
    warn("workspace", `Workspace no existe: ${modelPaths.workspaceRoot}`);
    nextStep(
      `Crea workspace: pnpm models:bootstrap -- --profile ${profile} --init-dirs`,
    );
    return;
  }

  mkdirSync(root, { recursive: true });
  ok("workspace", `Workspace creado: ${modelPaths.workspaceRoot}`);
}

function maybeCloneRepo(label, repo, targetPath) {
  if (!cloneRepos || dryRun) return;

  const target = fsPath(targetPath);
  if (!target) {
    warn(label, `No se puede clonar desde ${platform()} hacia ${targetPath}.`);
    return;
  }

  if (existsSync(target)) {
    if (existsSync(join(target, ".git"))) {
      ok(label, `${label} ya existe como repo git: ${targetPath}`);
    } else if (isEmptyDir(target)) {
      cloneRepo(label, repo, target);
    } else {
      warn(label, `${label} ya existe pero no parece repo git: ${targetPath}`);
    }
    return;
  }

  mkdirSync(dirname(target), { recursive: true });
  cloneRepo(label, repo, target);
}

function cloneRepo(label, repo, target) {
  const result = spawnSync("git", ["clone", "--depth", "1", repo, target], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status === 0) {
    ok(label, `${label} clonado: ${target}`);
    return;
  }
  error(
    label,
    `${label} no se pudo clonar desde ${repo}: ${trimProcessOutput(result)}`,
  );
}

function renderRuntimeEnv(modelPaths) {
  const result = runPrepareRuntime(modelPaths, true);
  return result.stdout;
}

function runPrepareRuntime(modelPaths, printOnly) {
  const commandArgs = [
    "scripts/prepare-ai-runtime-models.mjs",
    "--",
    "--profile",
    profile,
    "--preset",
    "local-wrappers",
    "--out",
    runtimeEnvPath,
    "--facefusion-dir",
    modelPaths.facefusionDir,
    "--facefusion-python",
    modelPaths.facefusionPython,
    "--bmv2-repo-dir",
    modelPaths.bmv2RepoDir,
    "--bmv2-python",
    modelPaths.bmv2Python,
    "--bmv2-checkpoint",
    modelPaths.bmv2Checkpoint,
  ];

  if (modelPaths.facefusionProviders) {
    commandArgs.push("--facefusion-providers", modelPaths.facefusionProviders);
  }
  if (modelPaths.bmv2Device) {
    commandArgs.push("--bmv2-device", modelPaths.bmv2Device);
  }
  if (vcclientEndpoint) {
    commandArgs.push("--vcclient000-http-endpoint", vcclientEndpoint);
  }
  if (printOnly) commandArgs.push("--print");

  const result = spawnSync(process.execPath, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
  });

  if (result.status !== 0) {
    error(
      "runtime",
      `No se pudo generar runtime: ${trimProcessOutput(result)}`,
    );
    if (strict) process.exit(result.status ?? 1);
  }

  return result;
}

function checkFaceFusion(modelPaths) {
  const repoPath = fsPath(modelPaths.facefusionDir);
  const pythonPath = fsPath(modelPaths.facefusionPython);
  if (!repoPath) {
    warn(
      "FaceFusion",
      `Ruta FaceFusion no verificable en ${platform()}: ${modelPaths.facefusionDir}`,
    );
    return;
  }

  if (!existsSync(repoPath)) {
    error(
      "FaceFusion",
      `FACEFUSION_DIR no existe: ${modelPaths.facefusionDir}`,
    );
    nextStep(
      `Clona FaceFusion: git clone ${facefusionRepo} ${modelPaths.facefusionDir}`,
    );
  } else {
    ok("FaceFusion", `FACEFUSION_DIR existe: ${modelPaths.facefusionDir}`);
  }

  const entrypoint = join(repoPath, "facefusion.py");
  if (existsSync(entrypoint)) {
    ok("FaceFusion", "Entrypoint facefusion.py encontrado.");
  } else {
    error(
      "FaceFusion",
      `No se encontró facefusion.py en ${modelPaths.facefusionDir}`,
    );
  }

  if (!pythonPath) {
    warn(
      "FaceFusion",
      `Python FaceFusion no verificable en ${platform()}: ${modelPaths.facefusionPython}`,
    );
  } else if (existsSync(pythonPath)) {
    ok(
      "FaceFusion",
      `Python FaceFusion existe: ${modelPaths.facefusionPython}`,
    );
  } else {
    warn(
      "FaceFusion",
      `Python FaceFusion no existe todavía: ${modelPaths.facefusionPython}`,
    );
    nextStep(
      "Crea el entorno Python de FaceFusion e instala sus dependencias.",
    );
  }
}

function checkBackgroundMatting(modelPaths) {
  const repoPath = fsPath(modelPaths.bmv2RepoDir);
  const pythonPath = fsPath(modelPaths.bmv2Python);
  const checkpointPath = fsPath(modelPaths.bmv2Checkpoint);
  if (!repoPath) {
    warn(
      "BackgroundMattingV2",
      `Ruta BMV2 no verificable en ${platform()}: ${modelPaths.bmv2RepoDir}`,
    );
    return;
  }

  if (!existsSync(repoPath)) {
    error(
      "BackgroundMattingV2",
      `BMV2_REPO_DIR no existe: ${modelPaths.bmv2RepoDir}`,
    );
    nextStep(
      `Clona BackgroundMattingV2: git clone ${bmv2Repo} ${modelPaths.bmv2RepoDir}`,
    );
  } else if (!existsSync(join(repoPath, "inference_images.py"))) {
    error(
      "BackgroundMattingV2",
      `BMV2_REPO_DIR no contiene inference_images.py: ${modelPaths.bmv2RepoDir}`,
    );
  } else {
    ok("BackgroundMattingV2", "Repo BackgroundMattingV2 listo.");
  }

  if (!pythonPath) {
    warn(
      "BackgroundMattingV2",
      `Python BMV2 no verificable en ${platform()}: ${modelPaths.bmv2Python}`,
    );
  } else if (existsSync(pythonPath)) {
    ok("BackgroundMattingV2", `Python BMV2 existe: ${modelPaths.bmv2Python}`);
  } else {
    warn(
      "BackgroundMattingV2",
      `Python BMV2 no existe todavía: ${modelPaths.bmv2Python}`,
    );
    nextStep(
      "Crea el entorno Python de BackgroundMattingV2 e instala sus dependencias.",
    );
  }

  if (!checkpointPath) {
    warn(
      "BackgroundMattingV2",
      `Checkpoint BMV2 no verificable en ${platform()}: ${modelPaths.bmv2Checkpoint}`,
    );
  } else if (existsSync(checkpointPath) && statSync(checkpointPath).size > 0) {
    ok("BackgroundMattingV2", "Checkpoint BackgroundMattingV2 encontrado.");
  } else {
    error(
      "BackgroundMattingV2",
      `Checkpoint BMV2 faltante: ${modelPaths.bmv2Checkpoint}`,
    );
    nextStep(
      "Descarga el checkpoint de BackgroundMattingV2 antes de probar fondo real.",
    );
  }
}

function checkNvidia() {
  const result = spawnSync(
    "nvidia-smi",
    [
      "--query-gpu=name,memory.total,driver_version",
      "--format=csv,noheader,nounits",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (result.status === 0 && result.stdout.trim()) {
    ok("GPU", `NVIDIA detectada: ${result.stdout.trim().split(/\r?\n/)[0]}`);
    return;
  }

  error("GPU", "nvidia-smi no está disponible o no detecta GPU NVIDIA.");
  nextStep(
    "Instala/actualiza driver NVIDIA y confirma `nvidia-smi` antes del demo real.",
  );
}

function voidCheckVcClient(endpoint) {
  if (!endpoint) {
    warn("vcclient000", "Endpoint VCClient no configurado.");
    return;
  }

  try {
    const parsed = new URL(endpoint);
    ok("vcclient000", `Endpoint configurado: ${parsed.href}`);
  } catch {
    error("vcclient000", `Endpoint inválido: ${endpoint}`);
    return;
  }

  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1200);
      fetch(process.argv[1], { method: "GET", signal: controller.signal })
        .then((response) => {
          clearTimeout(timeout);
          process.stdout.write(String(response.status));
        })
        .catch((error) => {
          clearTimeout(timeout);
          process.stderr.write(error.name || error.message);
          process.exit(2);
        });
      `,
      endpoint,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );

  if (result.status === 0) {
    ok("vcclient000", `VCClient responde HTTP ${result.stdout.trim()}.`);
  } else {
    warn("vcclient000", "VCClient REST no respondió en 127.0.0.1:18888.");
    nextStep("Arranca w-okada/VCClient antes de probar voz real.");
  }
}

function runDoctor(runtimePath) {
  const commandArgs = [
    "scripts/check-ai-model-runtime.mjs",
    "--",
    "--json",
    "--profile",
    profile,
    "--env-file",
    runtimePath,
  ];
  if (skipHardware) commandArgs.push("--skip-hardware");

  const result = spawnSync(process.execPath, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
  });

  let report = null;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    warn(
      "doctor",
      `models:doctor no devolvió JSON: ${trimProcessOutput(result)}`,
    );
    return;
  }

  for (const message of report.warnings ?? []) warn("doctor", message);
  for (const message of report.issues ?? []) error("doctor", message);
  for (const message of report.nextSteps ?? []) nextStep(message);
  if (report.ok) ok("doctor", "models:doctor pasó para el runtime generado.");
}

function writeTempRuntimeEnv() {
  if (writeRuntime) return runtimeEnvPath;
  tempDir = mkdtempSync(join(osTmpDir(), "shape-model-bootstrap-"));
  const tempPath = join(tempDir, "shape-ai-runtime.env");
  writeFileSync(tempPath, runtimeEnvContent);
  return tempPath;
}

function buildModelPaths(selectedProfile, root) {
  if (selectedProfile === "apple-silicon") {
    return {
      workspaceRoot: root,
      facefusionDir: joinProfilePath(root, "FaceFusion"),
      facefusionPython: joinProfilePath(root, "FaceFusion/.venv/bin/python"),
      facefusionProviders: "cpu",
      bmv2RepoDir: joinProfilePath(root, "BackgroundMattingV2"),
      bmv2Python: joinProfilePath(root, "BackgroundMattingV2/.venv/bin/python"),
      bmv2Checkpoint: joinProfilePath(
        root,
        "BackgroundMattingV2/pytorch_resnet50.pth",
      ),
      bmv2Device: "mps",
    };
  }

  return {
    workspaceRoot: root,
    facefusionDir: joinProfilePath(root, "FaceFusion"),
    facefusionPython: joinProfilePath(
      root,
      "FaceFusion\\.venv\\Scripts\\python.exe",
    ),
    facefusionProviders: "cuda",
    bmv2RepoDir: joinProfilePath(root, "BackgroundMattingV2"),
    bmv2Python: joinProfilePath(
      root,
      "BackgroundMattingV2\\.venv\\Scripts\\python.exe",
    ),
    bmv2Checkpoint: joinProfilePath(
      root,
      "BackgroundMattingV2\\pytorch_resnet50.pth",
    ),
    bmv2Device: "cuda",
  };
}

function joinProfilePath(root, child) {
  const normalizedRoot = root.replace(/[\\/]+$/, "");
  if (isWindowsPathString(root)) {
    return `${normalizedRoot}\\${child.replace(/\//g, "\\")}`;
  }
  return join(expandHome(normalizedRoot), child);
}

function checkCommand(command, label) {
  const result = spawnSync(
    process.platform === "win32" ? "where" : "which",
    [command],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  if (result.status === 0) ok(label, `${label} disponible: ${command}`);
  else warn(label, `${label} no está en PATH: ${command}`);
}

function basePythonCommand() {
  return process.platform === "win32" ? "python" : "python3";
}

function fsPath(value) {
  if (!value) return null;
  if (isWindowsPathString(value) && process.platform !== "win32") return null;
  return expandHome(value);
}

function expandHome(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function isWindowsPathString(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || value.includes("\\");
}

function isEmptyDir(path) {
  try {
    return readdirSync(path).length === 0;
  } catch {
    return false;
  }
}

function parseEnv(content) {
  const values = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;
    values[line.slice(0, equalsIndex).trim()] = line
      .slice(equalsIndex + 1)
      .trim();
  }
  return values;
}

function buildReport(modelPaths) {
  return {
    ok: !hasErrors() && (!strict || !hasWarnings()),
    profile,
    workspaceRoot,
    runtimeEnvPath,
    runtimeWritten: writeRuntime,
    checklistPath,
    checklistWritten,
    dryRun,
    modelPaths,
    runtimeEnv: {
      SHAPE_MODEL_WORKSTATION_PROFILE:
        runtimeEnv.SHAPE_MODEL_WORKSTATION_PROFILE,
      FACEFUSION_DIR: runtimeEnv.FACEFUSION_DIR,
      BMV2_REPO_DIR: runtimeEnv.BMV2_REPO_DIR,
      BMV2_MODEL_CHECKPOINT: runtimeEnv.BMV2_MODEL_CHECKPOINT,
      VCCLIENT000_HTTP_ENDPOINT: runtimeEnv.VCCLIENT000_HTTP_ENDPOINT,
    },
    checks,
    nextSteps,
  };
}

function printReport(modelPaths) {
  let report = buildReport(modelPaths);

  if (writeChecklist) {
    writeChecklistFile(report);
    report = buildReport(modelPaths);
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log("Shape Meet model workstation bootstrap");
  console.log(`Perfil: ${profile}`);
  console.log(`Workspace: ${workspaceRoot}`);
  console.log(`Runtime env: ${writeRuntime ? runtimeEnvPath : "no escrito"}`);
  if (writeChecklist) {
    console.log(
      `Checklist: ${checklistWritten ? checklistPath : "no escrito"}`,
    );
  }
  for (const check of checks) {
    console.log(`${check.status}: ${check.label}: ${check.message}`);
  }
  for (const step of nextSteps) console.log(`next: ${step}`);
}

function writeChecklistFile(report) {
  const target = fsPath(checklistPath);
  if (!target) {
    warn(
      "checklist",
      `Ruta checklist no verificable en ${platform()}: ${checklistPath}`,
    );
    return;
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, renderChecklist(report));
  checklistWritten = true;
  ok("checklist", `Checklist escrito: ${checklistPath}`);
}

function renderChecklist(report) {
  const statusCounts = {
    ok: report.checks.filter((check) => check.status === "ok").length,
    warn: report.checks.filter((check) => check.status === "warn").length,
    error: report.checks.filter((check) => check.status === "error").length,
  };
  const checkItems = report.checks
    .map((check) => {
      const mark = check.status === "ok" ? "x" : " ";
      return `- [${mark}] ${check.status.toUpperCase()} ${check.label}: ${check.message}`;
    })
    .join("\n");
  const nextStepItems = report.nextSteps.length
    ? report.nextSteps.map((step, index) => `${index + 1}. ${step}`).join("\n")
    : "No quedan siguientes pasos detectados por el bootstrap.";

  return `# Shape Meet Model Workstation Checklist

Perfil: ${report.profile}
Workspace: ${report.workspaceRoot}
Runtime env: ${report.runtimeWritten ? report.runtimeEnvPath : "pendiente"}
Dry-run: ${report.dryRun ? "si" : "no"}

## Estado

- OK: ${statusCounts.ok}
- Advertencias: ${statusCounts.warn}
- Errores: ${statusCounts.error}

## Rutas

- FaceFusion: ${report.modelPaths.facefusionDir}
- Python FaceFusion: ${report.modelPaths.facefusionPython}
- BackgroundMattingV2: ${report.modelPaths.bmv2RepoDir}
- Python BackgroundMattingV2: ${report.modelPaths.bmv2Python}
- Checkpoint BackgroundMattingV2: ${report.modelPaths.bmv2Checkpoint}
- VCClient: ${report.runtimeEnv.VCCLIENT000_HTTP_ENDPOINT || "no configurado"}

## Checks

${checkItems || "No se ejecutaron checks."}

## Siguientes Pasos

${nextStepItems}

## Comandos

\`\`\`bash
pnpm models:bootstrap -- --profile ${report.profile} --dry-run --write-checklist
pnpm models:bootstrap -- --profile ${report.profile} --write-runtime --strict --write-checklist
pnpm demo:real:check -- --env-file "${report.runtimeEnvPath}" --include-desktop
\`\`\`
`;
}

function ok(label, message) {
  checks.push({ status: "ok", label, message });
}

function warn(label, message) {
  checks.push({ status: "warn", label, message });
}

function error(label, message) {
  checks.push({ status: "error", label, message });
}

function nextStep(message) {
  if (!nextSteps.includes(message)) nextSteps.push(message);
}

function hasErrors() {
  return checks.some((check) => check.status === "error");
}

function hasWarnings() {
  return checks.some((check) => check.status === "warn");
}

function normalizeProfile(value) {
  const normalized = String(value || "windows-nvidia")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (["windows", "windows-nvidia", "nvidia", "rtx"].includes(normalized)) {
    return "windows-nvidia";
  }
  if (
    ["apple", "apple-silicon", "mac", "macos", "darwin", "mps"].includes(
      normalized,
    )
  ) {
    return "apple-silicon";
  }
  fail(`Perfil no soportado: ${value}`);
}

function defaultProfile() {
  return process.platform === "darwin" && process.arch === "arm64"
    ? "apple-silicon"
    : "windows-nvidia";
}

function defaultWorkspaceRoot(selectedProfile) {
  return selectedProfile === "apple-silicon" ? "~/models" : "C:\\models";
}

function defaultVcClientEndpoint(selectedProfile) {
  return selectedProfile === "windows-nvidia"
    ? "http://127.0.0.1:18888/test"
    : "";
}

function defaultRuntimeEnvPath() {
  if (process.platform === "win32") {
    return join(
      process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
      "Shape Meet",
      "shape-ai-runtime.env",
    );
  }
  if (process.platform === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "Shape Meet",
      "shape-ai-runtime.env",
    );
  }
  return join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "shape-meet",
    "shape-ai-runtime.env",
  );
}

function defaultChecklistPath(selectedProfile) {
  return join(
    repoRoot,
    "output",
    "model-workstation",
    `shape-model-workstation-${selectedProfile}.md`,
  );
}

function osTmpDir() {
  return process.env.TMPDIR || process.env.TEMP || "/tmp";
}

function trimProcessOutput(result) {
  return [result.stderr, result.stdout]
    .filter(Boolean)
    .join("\n")
    .trim()
    .slice(0, 1200);
}

function argValue(name) {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
