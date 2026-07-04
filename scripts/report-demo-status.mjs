import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const json = args.includes("--json");
const strict = args.includes("--strict");
const outputPath = argValue("--output");
const skipServices = args.includes("--skip-services");
const skipSentry = args.includes("--skip-sentry");
const skipRealCheck = args.includes("--skip-real-check");
const skipRemote = args.includes("--skip-remote");
const verifyPreview = args.includes("--verify-preview");
const verifyFull =
  args.includes("--verify-full") || args.includes("--verify-ui");
const verifyDesktop =
  args.includes("--verify-desktop") ||
  args.includes("--include-desktop") ||
  args.includes("--desktop");
const verifyHandoff = args.includes("--verify-handoff");
const sentryLive =
  args.includes("--sentry-live") ||
  args.includes("--live") ||
  args.includes("--send-test-event");
const explicitRemoteEnvFile = argValue("--remote-env-file");
const remoteEnvFile =
  explicitRemoteEnvFile ??
  (args.includes("--no-auto-remote") ? null : findLatestRemoteEnvFile());
const verifyRemote =
  args.includes("--verify-remote") || Boolean(remoteEnvFile && !skipRemote);
const remoteApiFlow =
  args.includes("--remote-api-flow") ||
  args.includes("--api-flow") ||
  args.includes("--check-api-flow");
const remoteIdentityFlow =
  args.includes("--remote-identity-flow") ||
  args.includes("--identity-flow") ||
  args.includes("--check-identity-flow");
const remoteTimeoutMs =
  argValue("--remote-timeout-ms") ?? argValue("--timeout-ms");
const apiUrl = trimTrailingSlash(
  argValue("--api-url") ??
    process.env.SHAPE_DEMO_API_URL ??
    readEnvValue("apps/desktop/.env.local", "VITE_SHAPE_API_URL") ??
    "http://localhost:13000",
);
const appUrl = trimTrailingSlash(
  argValue("--app-url") ??
    process.env.SHAPE_DEMO_APP_URL ??
    readEnvValue("apps/desktop/.env.local", "VITE_SHAPE_MEETING_URL") ??
    "http://localhost:1420",
);
const aiUrl = trimTrailingSlash(
  argValue("--ai-url") ??
    process.env.SHAPE_DEMO_AI_URL ??
    readEnvValue("apps/desktop/.env.local", "VITE_SHAPE_AI_SERVICE_URL") ??
    "http://127.0.0.1:7851",
);

const report = {
  generatedAt: new Date().toISOString(),
  ok: false,
  strict,
  targets: { apiUrl, appUrl, aiUrl, remoteEnvFile: remoteEnvFile ?? null },
  verified: {
    services: !skipServices,
    sentry: !skipSentry,
    sentryLive,
    realReadiness: !skipRealCheck,
    preview: verifyPreview,
    fullUi: verifyFull,
    desktopPackage: verifyDesktop,
    handoff: verifyHandoff,
    remoteDeployment: verifyRemote,
  },
  checks: {},
  readiness: {},
  nextSteps: [],
};

try {
  await main();
} catch (error) {
  report.checks.unhandled = {
    ok: false,
    label: "Error no controlado",
    error: error instanceof Error ? error.message : String(error),
  };
  finish(1);
}

async function main() {
  report.checks.services = skipServices
    ? skipped("Servicios locales", "omitido por --skip-services")
    : await checkLocalServices();

  report.checks.sentry = skipSentry
    ? skipped("Sentry", "omitido por --skip-sentry")
    : runSentryCheck();

  report.checks.realReadiness = skipRealCheck
    ? skipped("Demo real", "omitido por --skip-real-check")
    : runRealReadinessCheck();

  report.checks.remoteDeployment = verifyRemote
    ? runRemoteDeploymentCheck()
    : skipped(
        "Demo remoto",
        remoteEnvFile
          ? "omitido por --skip-remote"
          : "pasa --remote-env-file para validarlo",
      );

  report.checks.preview = verifyPreview
    ? commandStep("Preview local IA", ["demo:local-preview"], {
        timeout: 120_000,
      })
    : skipped("Preview local IA", "usa --verify-preview para validarlo");

  report.checks.fullUi = verifyFull
    ? commandStep("Demo local completo", ["demo:check", "--", "--verify-ui"], {
        timeout: 300_000,
      })
    : skipped("Demo local completo", "usa --verify-full para validarlo");

  report.checks.desktopPackage = verifyDesktop
    ? commandStep("Desktop Tauri", ["desktop:doctor", "--", "--strict"], {
        timeout: 90_000,
      })
    : skipped("Desktop Tauri", "usa --verify-desktop para validarlo");

  report.checks.handoff = verifyHandoff
    ? runHandoffCheck()
    : skipped("Demo handoff", "usa --verify-handoff para validarlo");

  collectReadiness();
  finish(report.ok ? 0 : strict ? 1 : 0);
}

async function checkLocalServices() {
  const checks = await Promise.all([
    jsonHealth("Admin/API", `${apiUrl}/api/health`, (data) => {
      return data?.ok === true && data?.database === "ok";
    }),
    textHealth("App reuniones", appUrl),
    jsonHealth("IA local", `${aiUrl}/health`, (data) => {
      return data?.status === "ready";
    }),
  ]);

  const doctor = commandStep(
    "Doctor demo",
    ["demo:doctor", "--", "--no-docker"],
    {
      timeout: 45_000,
    },
  );
  checks.push({
    ok: doctor.ok,
    label: "Doctor demo",
    status: doctor.status,
    summary: doctor.ok ? "ok" : doctor.stderr || doctor.stdout,
  });

  return {
    ok: checks.every((check) => check.ok),
    skipped: false,
    label: "Servicios locales",
    checks,
  };
}

function runSentryCheck() {
  const commandArgs = ["check:sentry", "--", "--json"];
  if (sentryLive) commandArgs.push("--live");
  const step = commandStep("Sentry", commandArgs, {
    parseJson: true,
    timeout: sentryLive ? 60_000 : 30_000,
  });
  step.live = sentryLive;
  step.issues = step.report?.issues ?? [];
  step.warnings = step.report?.warnings ?? [];
  step.nextSteps = step.report?.nextSteps ?? [];
  return step;
}

function runRealReadinessCheck() {
  const commandArgs = [
    "demo:real:check",
    "--",
    "--json",
    "--skip-sentry-live",
    "--skip-model-preflight",
  ];
  const step = commandStep("Demo real", commandArgs, {
    parseJson: true,
    timeout: 90_000,
  });
  step.readyForRealDemo = step.report?.readyForRealDemo === true;
  step.nextSteps = step.report?.nextSteps ?? [];
  step.realModelsConfigured =
    step.report?.steps?.realModels?.realModelsConfigured === true;
  return step;
}

function runRemoteDeploymentCheck() {
  if (!remoteEnvFile) {
    return {
      ok: false,
      skipped: false,
      label: "Demo remoto",
      error: "Falta --remote-env-file para validar Coolify/TURN remoto.",
    };
  }

  const commandArgs = [
    "demo:remote:check",
    "--",
    "--json",
    "--env-file",
    remoteEnvFile,
  ];
  if (strict) commandArgs.push("--strict");
  if (remoteTimeoutMs) commandArgs.push("--timeout-ms", remoteTimeoutMs);
  if (remoteApiFlow) commandArgs.push("--api-flow");
  if (remoteIdentityFlow) commandArgs.push("--identity-flow");
  forwardRemoteFlag(commandArgs, "--skip-network");
  forwardRemoteFlag(commandArgs, "--skip-turn-auth");
  forwardRemoteFlag(commandArgs, "--skip-turnutils");
  forwardRemoteFlag(commandArgs, "--skip-js-turn-auth");
  forwardRemoteFlag(commandArgs, "--skip-livekit-handshake");
  forwardRemoteFlag(commandArgs, "--skip-turn-tls");
  if (
    !commandArgs.includes("--skip-turn-tls") &&
    envFileFlag(remoteEnvFile, "SHAPE_REMOTE_SKIP_TURN_TLS")
  ) {
    commandArgs.push("--skip-turn-tls");
  }

  const step = commandStep("Demo remoto", commandArgs, {
    parseJson: true,
    timeout: positiveInteger(argValue("--remote-command-timeout-ms"), 120_000),
  });
  step.statusLabel = step.report?.status ?? (step.ok ? "passed" : "failed");
  step.target = step.report?.target ?? null;
  step.issues = step.report?.issues ?? [];
  step.warnings = step.report?.warnings ?? [];
  return step;
}

function runHandoffCheck() {
  const tempDir = mkdtempSync(join(tmpdir(), "shape-demo-status-handoff-"));
  try {
    const commandArgs = [
      "demo:handoff",
      "--",
      "--json",
      "--output-dir",
      tempDir,
      "--skip-prepare",
      "--skip-debug",
      "--skip-real-check",
      "--skip-local-preview",
      "--skip-verify-ui",
      "--skip-identity-push",
      "--skip-desktop",
      "--skip-coolify",
      "--skip-model-bootstrap",
    ];
    if (remoteEnvFile) commandArgs.push("--remote-env-file", remoteEnvFile);
    const step = commandStep("Demo handoff", commandArgs, {
      parseJson: true,
      timeout: 90_000,
    });
    step.windowsHandoff = step.report?.steps?.windowsHandoff?.ok === true;
    step.modelEndpoint = step.report?.demo?.windows?.modelEndpoint ?? null;
    return step;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function jsonHealth(label, url, predicate) {
  try {
    const response = await fetchWithTimeout(url, { timeoutMs: 5000 });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    return {
      ok: response.ok && predicate(data),
      label,
      url,
      status: response.status,
      summary: response.ok ? JSON.stringify(data) : text.slice(0, 240),
    };
  } catch (error) {
    return {
      ok: false,
      label,
      url,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function textHealth(label, url) {
  try {
    const response = await fetchWithTimeout(url, { timeoutMs: 5000 });
    const text = await response.text();
    return {
      ok: response.ok && /Shape Meet|root|<html/i.test(text),
      label,
      url,
      status: response.status,
      summary: text.slice(0, 160),
    };
  } catch (error) {
    return {
      ok: false,
      label,
      url,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fetchWithTimeout(url, { timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function collectReadiness() {
  const servicesOk = !skipServices && report.checks.services?.ok === true;
  const sentryOk = !skipSentry && report.checks.sentry?.ok === true;
  const sentryLiveOk =
    sentryLive && report.checks.sentry?.report?.liveResults?.length > 0
      ? report.checks.sentry.report.liveResults.every((item) => item.ok)
      : false;
  const realReady =
    !skipRealCheck && report.checks.realReadiness?.readyForRealDemo === true;
  const remoteOk = verifyRemote && report.checks.remoteDeployment?.ok === true;
  const previewOk =
    report.checks.preview?.ok === true && !report.checks.preview.skipped;
  const fullUiOk =
    report.checks.fullUi?.ok === true && !report.checks.fullUi.skipped;
  const desktopPackageOk =
    report.checks.desktopPackage?.ok === true &&
    !report.checks.desktopPackage.skipped;
  const handoffOk =
    report.checks.handoff?.ok === true && !report.checks.handoff.skipped;

  report.readiness = {
    localServices: servicesOk ? "ok" : skipServices ? "not-checked" : "review",
    sentryFormat: sentryOk ? "ok" : skipSentry ? "not-checked" : "review",
    sentryLive: sentryLive ? (sentryLiveOk ? "ok" : "review") : "not-checked",
    localPreview: verifyPreview ? (previewOk ? "ok" : "review") : "not-checked",
    localFullDemo: verifyFull ? (fullUiOk ? "ok" : "review") : "not-checked",
    desktopPackage: verifyDesktop
      ? desktopPackageOk
        ? "ok"
        : "review"
      : "not-checked",
    demoHandoff: verifyHandoff ? (handoffOk ? "ok" : "review") : "not-checked",
    remoteDeployment: verifyRemote
      ? remoteOk
        ? "ok"
        : "review"
      : remoteEnvFile
        ? "not-checked"
        : "not-configured",
    realModelDemo: realReady ? "ok" : skipRealCheck ? "not-checked" : "blocked",
    demoPercent: demoPercent({
      servicesOk,
      sentryOk,
      sentryLiveOk,
      realReady,
      remoteOk,
      previewOk,
      fullUiOk,
      handoffOk,
    }),
  };

  const nextSteps = [];
  if (!servicesOk && !skipServices) {
    nextSteps.push(
      "Levanta el stack con `pnpm demo:up` o revisa `pnpm demo:doctor -- --no-docker`.",
    );
  }
  if (!verifyPreview) {
    nextSteps.push(
      "Ejecuta `pnpm demo:status -- --verify-preview` para validar preview IA sin Docker.",
    );
  }
  if (!verifyFull) {
    nextSteps.push(
      "Ejecuta `pnpm demo:status -- --verify-full` antes de enseñar el flujo host/invitado.",
    );
  }
  if (!verifyDesktop) {
    nextSteps.push(
      "Ejecuta `pnpm demo:status -- --verify-desktop` para validar sidecar, recursos y config Tauri.",
    );
  }
  if (verifyDesktop && !desktopPackageOk) {
    nextSteps.push(
      "Corrige desktop con `pnpm build:ai-sidecar` y repite `pnpm desktop:doctor -- --strict`.",
    );
  }
  if (!verifyHandoff) {
    nextSteps.push(
      "Ejecuta `pnpm demo:status -- --verify-handoff` para validar el paquete operativo Windows/demo.",
    );
  }
  if (!verifyRemote && !remoteEnvFile) {
    nextSteps.push(
      "Cuando exista el env de Coolify, ejecuta `pnpm demo:status -- --remote-env-file infra/shape-meet.production.env --remote-api-flow --remote-identity-flow`.",
    );
  }
  if (verifyRemote && !remoteOk) {
    nextSteps.push(
      "Corrige el deployment remoto con `pnpm demo:remote:check -- --env-file <env> --api-flow --identity-flow --strict`.",
    );
  }
  if (!sentryLive) {
    nextSteps.push(
      "Ejecuta `pnpm demo:status -- --sentry-live` cuando tengas una DSN válida.",
    );
  }
  if (Array.isArray(report.checks.sentry?.nextSteps)) {
    nextSteps.push(...report.checks.sentry.nextSteps);
  }
  if (Array.isArray(report.checks.realReadiness?.nextSteps)) {
    nextSteps.push(...report.checks.realReadiness.nextSteps);
  }

  report.nextSteps = [...new Set(nextSteps)].slice(0, 12);
  report.ok = Object.values(report.checks).every(
    (step) => step.skipped || step.ok,
  );
}

function demoPercent(input) {
  const weights = [
    [input.servicesOk, 25],
    [input.sentryOk, 10],
    [input.previewOk, 15],
    [input.fullUiOk, 25],
    [input.handoffOk, 10],
    [input.remoteOk, 5],
    [input.sentryLiveOk, 5],
    [input.realReady, 5],
  ];
  return weights.reduce((total, [ok, weight]) => total + (ok ? weight : 0), 0);
}

function commandStep(label, commandArgs, options = {}) {
  const startedAt = Date.now();
  const result = runPnpm(commandArgs, options);
  const parsed = options.parseJson ? parseJson(result.stdout) : null;
  const ok = result.status === 0 && parsed?.ok !== false;
  return {
    ok,
    skipped: false,
    label,
    command: result.command,
    status: result.status,
    durationMs: Date.now() - startedAt,
    report: parsed,
    stdout: parsed ? undefined : trimOutput(result.stdout),
    stderr: trimOutput(result.stderr),
  };
}

function runPnpm(commandArgs, options = {}) {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(command, commandArgs, {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: options.timeout ?? 60_000,
    maxBuffer: 30 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    command: [command, ...commandArgs].join(" "),
    status:
      typeof result.status === "number" ? result.status : result.error ? 1 : 0,
    stdout: result.stdout ?? "",
    stderr:
      result.stderr ??
      (result.error instanceof Error ? result.error.message : ""),
  };
}

function skipped(label, reason) {
  return { ok: true, skipped: true, label, reason };
}

function forwardRemoteFlag(target, name) {
  if (args.includes(name)) target.push(name);
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseJson(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first < 0 || last <= first) return null;
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      return null;
    }
  }
}

function trimOutput(value) {
  const text = String(value ?? "").trim();
  return text.length > 3000 ? `${text.slice(0, 3000)}...<truncated>` : text;
}

function readEnvValue(path, key) {
  try {
    const content = readFileSync(resolve(path), "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const equalsIndex = line.indexOf("=");
      if (equalsIndex === -1) continue;
      if (line.slice(0, equalsIndex).trim() !== key) continue;
      return unquote(line.slice(equalsIndex + 1).trim());
    }
  } catch {
    return null;
  }
  return null;
}

function envFileFlag(path, key) {
  const value = path ? readEnvValue(path, key) : null;
  return /^(1|true|yes|on)$/i.test(value ?? "");
}

function findLatestRemoteEnvFile() {
  const root = resolve("output/coolify-deploy");
  if (!existsSync(root)) return null;

  const candidates = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const envPath = resolve(root, entry.name, "remote-demo.env");
    if (!existsSync(envPath)) continue;
    const stats = statSync(envPath);
    candidates.push({ path: envPath, mtimeMs: stats.mtimeMs });
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.path ?? null;
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function trimTrailingSlash(value) {
  return String(value ?? "").replace(/\/$/, "");
}

function argValue(name) {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

function finish(code) {
  if (outputPath) {
    const absoluteOutputPath = resolve(outputPath);
    mkdirSync(dirname(absoluteOutputPath), { recursive: true });
    writeFileSync(absoluteOutputPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("Shape Meet demo status");
    console.log(`Estado: ${report.ok ? "ok" : "revisar"}`);
    console.log(`Demo verificado: ${report.readiness.demoPercent ?? 0}%`);
    for (const [key, value] of Object.entries(report.readiness)) {
      if (key === "demoPercent") continue;
      console.log(`- ${key}: ${value}`);
    }
    if (report.nextSteps.length > 0) {
      console.log("");
      console.log("Siguientes pasos:");
      report.nextSteps.forEach((step, index) => {
        console.log(`${index + 1}. ${step}`);
      });
    }
  }
  process.exit(code);
}
