import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const args = process.argv.slice(2);
const json = args.includes("--json");
const includeLatest = args.includes("--latest");
const strictLatest = args.includes("--strict-latest");
const workflowPath = join(
  repoRoot,
  ".github",
  "workflows",
  "desktop-packages.yml",
);
const workflow = existsSync(workflowPath)
  ? readFileSync(workflowPath, "utf8")
  : "";
const packageJson = readJson(join(repoRoot, "package.json"));
const checks = [];
const warnings = [];
const issues = [];
let latestRun = null;

main();

function main() {
  checkWorkflowExists();
  checkTriggers();
  checkRuntimeConfigJob();
  checkPackageMatrix();
  checkPackageSteps();
  checkLocalScripts();
  if (includeLatest) checkLatestRun();
  printReport();

  if (issues.length > 0) process.exit(1);
}

function checkWorkflowExists() {
  if (!workflow) {
    fail("Falta .github/workflows/desktop-packages.yml.");
    return;
  }
  expectText("name: Desktop Packages", "workflow Desktop Packages declarado");
}

function checkTriggers() {
  expectText("workflow_dispatch:", "workflow ejecutable manualmente");
  for (const input of [
    "admin_url:",
    "meeting_url:",
    "ai_url:",
    "host_identifier:",
    "sentry_dsn:",
    "sentry_environment:",
    "sentry_release:",
    "sentry_traces_sample_rate:",
    "sentry_debug:",
  ]) {
    expectText(input, `input ${input.replace(":", "")} disponible`);
  }
  expectText("desktop-v*", "workflow dispara por tags desktop-v*");
  expectText(
    "cancel-in-progress: false",
    "builds desktop no se cancelan entre si",
  );
}

function checkRuntimeConfigJob() {
  expectText("runtime-config:", "job runtime-config presente");
  expectText("runs-on: ubuntu-latest", "runtime config usa ubuntu-latest");
  expectText(
    "args=(--out output/desktop-runtime/shape-meet.env)",
    "runtime config genera shape-meet.env",
  );
  for (const expected of [
    "vars.DESKTOP_SHAPE_API_URL",
    "vars.DESKTOP_SHAPE_MEETING_URL",
    "vars.DESKTOP_SHAPE_AI_SERVICE_URL",
    "vars.DESKTOP_SHAPE_HOST_IDENTIFIER",
    "vars.DESKTOP_SENTRY_DSN",
    "secrets.DESKTOP_SENTRY_DSN",
    "args+=(--api-url",
    "args+=(--meeting-url",
    "args+=(--ai-url",
    "args+=(--host-identifier",
    "args+=(--sentry-dsn",
    "args+=(--sentry-environment",
    "args+=(--release",
    "args+=(--sentry-traces-sample-rate",
    "args+=(--sentry-debug",
    'pnpm desktop:config -- "${args[@]}"',
  ]) {
    expectText(expected, `runtime config usa ${expected}`);
  }
  expectText(
    "name: shape-meet-runtime-config",
    "artifact runtime config declarado",
  );
  expectText(
    "path: output/desktop-runtime/shape-meet.env",
    "artifact runtime config apunta al env generado",
  );
  expectText("retention-days: 14", "artifacts retienen 14 dias");
}

function checkPackageMatrix() {
  const targets = [
    {
      name: "Windows x64",
      runner: "windows-latest",
      artifact: "shape-meet-windows-x64",
      tauriArgs: 'tauriArgs: ""',
    },
    {
      name: "macOS Apple Silicon",
      runner: "macos-26",
      artifact: "shape-meet-macos-arm64",
      tauriArgs: 'tauriArgs: "--no-sign"',
    },
    {
      name: "macOS Intel",
      runner: "macos-26-intel",
      artifact: "shape-meet-macos-x64",
      tauriArgs: 'tauriArgs: "--no-sign"',
    },
  ];

  for (const target of targets) {
    expectTarget(target);
  }
}

function expectTarget(target) {
  const block = workflowBlockForTarget(target.name);
  if (!block) {
    fail(`Matriz desktop no incluye ${target.name}.`);
    return;
  }

  for (const [label, expected] of [
    ["runner", `runner: ${target.runner}`],
    ["artifact", `artifact: ${target.artifact}`],
    ["tauriArgs", target.tauriArgs],
  ]) {
    if (!block.includes(expected)) {
      fail(`${target.name} no declara ${label} esperado: ${expected}.`);
    }
  }
  ok(`${target.name}: ${target.runner} -> ${target.artifact}`);
}

function workflowBlockForTarget(name) {
  const start = workflow.indexOf(`- name: ${name}`);
  if (start === -1) return null;
  const rest = workflow.slice(start);
  const nextTarget = rest.slice(1).search(/\n\s+- name: /);
  return nextTarget === -1 ? rest : rest.slice(0, nextTarget + 1);
}

function checkPackageSteps() {
  expectText("needs: runtime-config", "package espera runtime-config");
  expectText(
    "uses: actions/download-artifact@v4",
    "package descarga runtime config generado",
  );
  expectText(
    "name: shape-meet-runtime-config",
    "package descarga artifact shape-meet-runtime-config",
  );
  expectText(
    "path: apps/desktop/src-tauri/resources",
    "package ubica runtime config en recursos Tauri",
  );

  const orderedSteps = [
    "pnpm install --frozen-lockfile",
    "uses: actions/download-artifact@v4",
    "pnpm --filter @shape-meet/desktop sidecar:build",
    "pnpm desktop:doctor -- --strict",
    "pnpm --filter @shape-meet/desktop exec tauri build --config src-tauri/tauri.sidecar.conf.json",
    "pnpm desktop:bundle:check",
    "path: apps/desktop/src-tauri/target/release/bundle/**",
  ];

  let previousIndex = -1;
  for (const step of orderedSteps) {
    const index = workflow.indexOf(step);
    if (index === -1) {
      fail(`Workflow desktop no contiene paso requerido: ${step}`);
      continue;
    }
    if (index < previousIndex) {
      fail(`Workflow desktop ejecuta fuera de orden: ${step}`);
    }
    previousIndex = index;
  }

  expectText("uses: actions/upload-artifact@v4", "workflow sube artifacts");
  ok("orden de sidecar, doctor, build, bundle check y upload validado");
}

function checkLocalScripts() {
  const scripts = packageJson?.scripts ?? {};
  for (const script of [
    "desktop:config",
    "desktop:doctor",
    "desktop:bundle:check",
    "build:ai-sidecar",
    "build:desktop",
  ]) {
    if (!scripts[script]) fail(`package.json no define ${script}.`);
    else ok(`script ${script} disponible`);
  }

  for (const file of [
    "scripts/prepare-desktop-runtime-config.mjs",
    "scripts/check-desktop-release.mjs",
    "scripts/check-desktop-bundle.mjs",
    "apps/desktop/src-tauri/tauri.conf.json",
  ]) {
    if (!existsSync(join(repoRoot, file))) fail(`Falta ${file}.`);
  }
}

function checkLatestRun() {
  const result = spawnSync(
    "gh",
    [
      "run",
      "list",
      "--workflow",
      "Desktop Packages",
      "--limit",
      "1",
      "--json",
      "databaseId,status,conclusion,url,name,createdAt,headSha,event",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );

  if (result.status !== 0) {
    const message = `No se pudo consultar ultimo Desktop Packages con gh: ${trim(result.stderr || result.stdout)}`;
    if (strictLatest) fail(message);
    else warn(message);
    return;
  }

  const runs = parseJson(result.stdout);
  latestRun = Array.isArray(runs) ? runs[0] : null;
  if (!latestRun) {
    warn("No hay ejecuciones previas de Desktop Packages.");
    return;
  }

  if (latestRun.status !== "completed") {
    warn(
      `Desktop Packages ultimo run sigue ${latestRun.status}: ${latestRun.url}`,
    );
    return;
  }
  if (latestRun.conclusion !== "success") {
    const message = `Desktop Packages ultimo run termino ${latestRun.conclusion}: ${latestRun.url}`;
    if (strictLatest) fail(message);
    else warn(message);
    return;
  }
  ok(`ultimo Desktop Packages ok: ${latestRun.url}`);
}

function expectText(text, label) {
  if (!workflow.includes(text)) fail(`Workflow desktop no contiene: ${text}`);
  else ok(label);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
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
  const payload = {
    ok: issues.length === 0,
    workflow: relative(workflowPath),
    checks,
    warnings,
    issues,
    latestRun,
  };

  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log("Desktop package workflow check");
  for (const check of checks) console.log(`ok: ${check}`);
  for (const warning of warnings) console.warn(`warn: ${warning}`);
  for (const issue of issues) console.error(`fail: ${issue}`);
  console.log(
    issues.length === 0
      ? "Desktop package workflow check ok"
      : "Desktop package workflow check failed",
  );
}

function relative(path) {
  return path.startsWith(repoRoot) ? path.slice(repoRoot.length + 1) : path;
}

function trim(value) {
  const text = String(value ?? "").trim();
  return text.length > 600 ? `${text.slice(0, 600)}...<truncated>` : text;
}
