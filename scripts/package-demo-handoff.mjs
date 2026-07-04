import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const args = process.argv.slice(2);
const generatedAt = new Date().toISOString();
const safeNow = generatedAt.replace(/[:.]/g, "-");
const outputDir = resolve(
  repoRoot,
  argValue("--output-dir") ?? join("output", "demo-handoff", safeNow),
);
const json = args.includes("--json");
const strict = args.includes("--strict");
const skipPrepare = args.includes("--skip-prepare");
const skipDebug = args.includes("--skip-debug");
const skipRealCheck = args.includes("--skip-real-check");
const skipDesktop = args.includes("--skip-desktop");
const skipModelBootstrap = args.includes("--skip-model-bootstrap");
const desktopMode = normalizeDesktopMode(
  argValue("--desktop-mode") ??
    (args.includes("--local-bundle") ? "local" : null) ??
    (args.includes("--github-desktop") ? "github" : null) ??
    "auto",
);
const profile =
  argValue("--profile") ??
  process.env.SHAPE_MODEL_WORKSTATION_PROFILE ??
  "windows-nvidia";
const runtimeEnvFile =
  argValue("--env-file") ?? process.env.SHAPE_AI_RUNTIME_ENV_FILE ?? null;
const remoteEnvFile = argValue("--remote-env-file") ?? null;
const timeoutMs = argValue("--timeout-ms") ?? "45000";
const remoteTimeoutMs = argValue("--remote-timeout-ms") ?? null;

const report = {
  generatedAt,
  ok: false,
  outputDir,
  repo: inspectGit(),
  options: {
    strict,
    desktopMode,
    profile,
    runtimeEnvFile,
    remoteEnvFile,
    timeoutMs,
    remoteTimeoutMs,
  },
  steps: {},
  artifacts: {},
  demo: {},
  nextSteps: [],
};

try {
  main();
} catch (error) {
  report.steps.unhandled = {
    ok: false,
    label: "Error no controlado",
    error: error instanceof Error ? error.message : String(error),
  };
  finish(1);
}

function main() {
  mkdirSync(outputDir, { recursive: true });

  report.steps.prepare = skipPrepare
    ? skipped("Datos demo local", "omitido por --skip-prepare")
    : runPrepareStep();

  report.steps.debug = skipDebug
    ? skipped("Debug bundle", "omitido por --skip-debug")
    : runDebugStep();

  report.steps.realReadiness = skipRealCheck
    ? skipped("Readiness demo real", "omitido por --skip-real-check")
    : runRealReadinessStep();

  report.steps.desktop =
    skipDesktop || desktopMode === "skip"
      ? skipped("Desktop handoff", "omitido por --skip-desktop")
      : runDesktopStep();

  report.steps.modelBootstrap = skipModelBootstrap
    ? skipped("Bootstrap modelos", "omitido por --skip-model-bootstrap")
    : runModelBootstrapStep();

  collectSummary();
  report.artifacts.manifest = join(outputDir, "manifest.json");
  report.artifacts.readme = join(outputDir, "README.md");
  writeFileSync(
    join(outputDir, "manifest.json"),
    `${JSON.stringify(redact(report), null, 2)}\n`,
  );
  writeFileSync(join(outputDir, "README.md"), renderReadme(redact(report)));

  finish(strict && !report.ok ? 1 : 0);
}

function runPrepareStep() {
  const commandArgs = ["demo:prepare", "--"];
  forwardFlag(commandArgs, "--no-reset");
  forwardValue(commandArgs, "--api-url");
  forwardValue(commandArgs, "--app-url");
  forwardValue(commandArgs, "--host");
  forwardValue(commandArgs, "--title");
  forwardValue(commandArgs, "--identity-name");
  forwardValue(commandArgs, "--starts-in-minutes");

  const step = commandStep("Datos demo local", commandArgs, {
    timeout: 30_000,
  });
  const details = parsePrepareOutput(step.stdout);
  step.details = details;
  if (details.meetingCode || details.publicLink || details.host) {
    report.demo = {
      ...report.demo,
      host: details.host,
      meetingCode: details.meetingCode,
      publicLink: details.publicLink,
      guestName: details.guestName,
    };
  }
  return step;
}

function runDebugStep() {
  const debugDir = join(outputDir, "debug");
  const step = commandStep("Debug bundle", [
    "demo:debug",
    "--",
    "--output-dir",
    debugDir,
  ]);
  const outputPath =
    parseDebugBundlePath(step.stdout) ?? newestJsonFile(debugDir) ?? null;
  step.outputPath = outputPath;
  report.artifacts.debugBundle = outputPath;
  if (outputPath && existsSync(outputPath)) {
    const bundle = parseJson(readFileSync(outputPath, "utf8"));
    if (bundle?.demo?.ready) step.ready = bundle.demo.ready;
    if (bundle?.modelRuntime) step.modelRuntime = bundle.modelRuntime;
  }
  return step;
}

function runRealReadinessStep() {
  const outputPath = join(outputDir, "real-demo-readiness.json");
  const commandArgs = [
    "demo:real:check",
    "--",
    "--include-desktop",
    "--timeout-ms",
    timeoutMs,
    "--output",
    outputPath,
    "--json",
  ];

  if (runtimeEnvFile) commandArgs.push("--env-file", runtimeEnvFile);
  if (remoteEnvFile) commandArgs.push("--remote-env-file", remoteEnvFile);
  if (remoteTimeoutMs) commandArgs.push("--remote-timeout-ms", remoteTimeoutMs);
  if (profile) commandArgs.push("--profile", profile);
  forwardFlag(commandArgs, "--remote-api-flow");
  forwardFlag(commandArgs, "--api-flow");
  forwardValue(commandArgs, "--remote-command-timeout-ms");
  forwardFlag(commandArgs, "--require-real-models");
  forwardFlag(commandArgs, "--skip-sentry");
  forwardFlag(commandArgs, "--skip-model-doctor");
  forwardFlag(commandArgs, "--skip-model-preflight");
  forwardFlag(commandArgs, "--force-model-preflight");
  forwardFlag(commandArgs, "--skip-video");
  forwardFlag(commandArgs, "--skip-audio");
  forwardValue(commandArgs, "--frame");
  forwardValue(commandArgs, "--identity");
  forwardValue(commandArgs, "--clean-plate");
  forwardValue(commandArgs, "--audio");
  if (strict) commandArgs.push("--strict");

  const step = commandStep("Readiness demo real", commandArgs, {
    parseJson: true,
    timeout: positiveInteger(timeoutMs, 45_000) + 60_000,
  });
  step.outputPath = outputPath;
  if (!step.report && existsSync(outputPath)) {
    step.report = parseJson(readFileSync(outputPath, "utf8"));
  }
  report.artifacts.realReadiness = existsSync(outputPath) ? outputPath : null;
  return step;
}

function runDesktopStep() {
  const resolvedMode = resolveDesktopMode();
  const out = join(outputDir, "desktop-handoff", resolvedMode);
  const commandArgs = ["desktop:handoff", "--", "--json", "--out", out];

  if (resolvedMode === "local") {
    commandArgs.push("--local-bundle");
    const bundleDir =
      argValue("--bundle-dir") ?? argValue("--local-bundle-dir");
    if (bundleDir) commandArgs.push("--bundle-dir", bundleDir);
    forwardFlag(commandArgs, "--copy-local");
    forwardFlag(commandArgs, "--skip-bundle-check");
  } else {
    forwardValue(commandArgs, "--repo");
    forwardValue(commandArgs, "--run-id");
    forwardValue(commandArgs, "--workflow");
    forwardFlag(commandArgs, "--download");
    forwardFlag(commandArgs, "--allow-stale");
    forwardFlag(commandArgs, "--strict-latest");
  }

  const step = commandStep("Desktop handoff", commandArgs, {
    parseJson: true,
    timeout: resolvedMode === "local" ? 45_000 : 60_000,
  });
  step.mode = resolvedMode;
  step.outputDir = out;
  report.artifacts.desktopHandoff = out;
  return step;
}

function runModelBootstrapStep() {
  const modelDir = join(outputDir, "model-workstation");
  const checklistPath = join(modelDir, `shape-model-workstation-${profile}.md`);
  const setupScriptPath = join(
    modelDir,
    profile === "apple-silicon"
      ? "setup-apple-silicon.sh"
      : "setup-windows-nvidia.ps1",
  );
  const commandArgs = [
    "models:bootstrap",
    "--",
    "--json",
    "--dry-run",
    "--write-checklist",
    "--checklist-out",
    checklistPath,
    "--write-setup-script",
    "--setup-script-out",
    setupScriptPath,
    "--profile",
    profile,
  ];

  forwardValue(commandArgs, "--workspace");
  forwardValue(commandArgs, "--facefusion-repo");
  forwardValue(commandArgs, "--bmv2-repo");
  forwardValue(commandArgs, "--vcclient000-http-endpoint");
  forwardValue(commandArgs, "--vcclient000-http-mode");
  forwardFlag(commandArgs, "--skip-hardware");
  forwardFlag(commandArgs, "--skip-vcclient");
  if (strict) commandArgs.push("--strict");

  const step = commandStep("Bootstrap modelos", commandArgs, {
    parseJson: true,
    timeout: 60_000,
  });
  step.outputDir = modelDir;
  step.checklistPath = existsSync(checklistPath) ? checklistPath : null;
  step.setupScriptPath = existsSync(setupScriptPath) ? setupScriptPath : null;
  report.artifacts.modelChecklist = step.checklistPath;
  report.artifacts.modelSetupScript = step.setupScriptPath;
  return step;
}

function commandStep(label, commandArgs, options = {}) {
  const startedAt = Date.now();
  const result = runPnpm(commandArgs, options);
  const parsed = options.parseJson ? parseJson(result.stdout) : null;
  return {
    ok: result.status === 0,
    skipped: false,
    label,
    command: redactCommand(result.command),
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
    cwd: repoRoot,
    encoding: "utf8",
    timeout: options.timeout ?? 60_000,
    maxBuffer: 20 * 1024 * 1024,
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

function collectSummary() {
  report.ok = Object.values(report.steps).every(
    (step) => step.skipped || step.ok,
  );

  const readiness = report.steps.realReadiness?.report;
  if (readiness) {
    report.demo.realReadiness = {
      ok: readiness.ok,
      readyForRealDemo: readiness.readyForRealDemo,
      realModelsConfigured:
        readiness.steps?.realModels?.realModelsConfigured ?? false,
      remoteDemo:
        readiness.steps?.remoteDemo?.skipped === true
          ? "skipped"
          : readiness.steps?.remoteDemo?.ok === true
            ? "ok"
            : "review",
    };
  }

  const desktopReport = report.steps.desktop?.report;
  if (desktopReport) {
    report.demo.desktop = {
      ok: desktopReport.ok,
      mode: report.steps.desktop.mode,
      source: desktopReport.source ?? "github-actions",
      artifacts: Array.isArray(desktopReport.artifacts)
        ? desktopReport.artifacts.map((artifact) => artifact.name)
        : [],
    };
  }

  const modelReport = report.steps.modelBootstrap?.report;
  if (modelReport) {
    report.demo.models = {
      ok: modelReport.ok,
      profile: modelReport.profile,
      warnings: modelReport.checks?.filter((check) => check.status === "warn")
        .length,
      errors: modelReport.checks?.filter((check) => check.status === "error")
        .length,
    };
  }

  const nextSteps = [];
  if (!report.steps.prepare?.ok && !report.steps.prepare?.skipped) {
    nextSteps.push(
      "Levanta el stack local con `pnpm demo:up` antes de crear la reunion demo.",
    );
  }
  if (Array.isArray(readiness?.nextSteps))
    nextSteps.push(...readiness.nextSteps);
  if (Array.isArray(modelReport?.nextSteps))
    nextSteps.push(...modelReport.nextSteps);
  if (!report.steps.desktop?.ok && !report.steps.desktop?.skipped) {
    nextSteps.push(
      "Genera o descarga el bundle desktop antes del handoff de instalacion.",
    );
  }

  report.nextSteps = [...new Set(nextSteps)].slice(0, 16);
}

function renderReadme(currentReport) {
  const stepLines = Object.values(currentReport.steps)
    .map((step) => {
      const state = step.skipped ? "omitido" : step.ok ? "ok" : "revisar";
      return `- ${step.label}: ${state}`;
    })
    .join("\n");
  const artifactLines = Object.entries(currentReport.artifacts)
    .filter(([, value]) => value)
    .map(([key, value]) => `- ${key}: ${relativePath(value)}`)
    .join("\n");
  const demoLines = [
    currentReport.demo.host ? `- Host: ${currentReport.demo.host}` : null,
    currentReport.demo.meetingCode
      ? `- Codigo reunion: ${currentReport.demo.meetingCode}`
      : null,
    currentReport.demo.publicLink
      ? `- Link publico: ${currentReport.demo.publicLink}`
      : null,
    currentReport.demo.guestName
      ? `- Invitado sugerido: ${currentReport.demo.guestName}`
      : null,
    currentReport.demo.realReadiness
      ? `- Demo real listo: ${
          currentReport.demo.realReadiness.readyForRealDemo ? "si" : "no"
        }`
      : null,
    currentReport.demo.desktop?.artifacts?.length
      ? `- Desktop artifacts: ${currentReport.demo.desktop.artifacts.join(", ")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
  const nextStepLines = currentReport.nextSteps.length
    ? currentReport.nextSteps
        .map((step, index) => `${index + 1}. ${step}`)
        .join("\n")
    : "No quedan siguientes pasos detectados por el paquete.";

  return `# Shape Meet Demo Handoff

Generado: ${currentReport.generatedAt}
Estado: ${currentReport.ok ? "listo" : "revisar"}
Commit: ${currentReport.repo.commit || "desconocido"}

## Estado

${stepLines || "- Sin pasos ejecutados."}

## Demo

${demoLines || "- No se generaron datos de reunion en este paquete."}

## Artefactos

${artifactLines || "- Sin artefactos generados."}

## Siguientes pasos

${nextStepLines}

## Comandos utiles

\`\`\`bash
pnpm demo:up
pnpm demo:verify
pnpm demo:handoff
pnpm demo:real:check -- --include-desktop --require-real-models --strict
pnpm models:bootstrap -- --profile ${currentReport.options.profile} --write-runtime --strict --write-checklist
\`\`\`
`;
}

function inspectGit() {
  return {
    branch: runGit(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim(),
    commit: runGit(["rev-parse", "--short", "HEAD"]).stdout.trim(),
    statusShort: runGit(["status", "--short"]).stdout.trim(),
    lastCommit: runGit(["log", "-1", "--pretty=%h %s"]).stdout.trim(),
  };
}

function runGit(gitArgs) {
  const result = spawnSync("git", gitArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  return {
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

function resolveDesktopMode() {
  if (desktopMode !== "auto") return desktopMode;
  return localBundleLooksAvailable() ? "local" : "github";
}

function localBundleLooksAvailable() {
  const bundleDir = resolve(
    repoRoot,
    argValue("--bundle-dir") ??
      argValue("--local-bundle-dir") ??
      join("apps", "desktop", "src-tauri", "target", "release", "bundle"),
  );
  if (!existsSync(bundleDir)) return false;
  return hasAnyFile(bundleDir);
}

function hasAnyFile(path) {
  for (const entry of readdirSync(path)) {
    const fullPath = join(path, entry);
    const stats = statSync(fullPath);
    if (stats.isFile()) return true;
    if (stats.isDirectory() && hasAnyFile(fullPath)) return true;
  }
  return false;
}

function parsePrepareOutput(value) {
  return {
    host: matchLine(value, /^- Host:\s*(.+)$/m),
    meetingCode: matchLine(value, /^- Meeting code:\s*(.+)$/m),
    publicLink: matchLine(value, /^- Public link:\s*(.+)$/m),
    guestName: matchLine(value, /^- Guest name:\s*(.+)$/m),
  };
}

function parseDebugBundlePath(value) {
  return matchLine(value, /^Debug bundle escrito:\s*(.+)$/m);
}

function newestJsonFile(dir) {
  if (!existsSync(dir)) return null;
  const candidates = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(dir, name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  return candidates[0] ?? null;
}

function matchLine(value, pattern) {
  return (
    String(value ?? "")
      .match(pattern)?.[1]
      ?.trim() ?? null
  );
}

function forwardFlag(target, name) {
  if (args.includes(name)) target.push(name);
}

function forwardValue(target, name) {
  const value = argValue(name);
  if (value) target.push(name, value);
}

function normalizeDesktopMode(value) {
  const normalized = String(value ?? "auto")
    .trim()
    .toLowerCase();
  if (["auto", "local", "github", "skip"].includes(normalized))
    return normalized;
  throw new Error(`--desktop-mode invalido: ${value}`);
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function argValue(name) {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function parseJson(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(trimmed.slice(first, last + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function trimOutput(value) {
  const text = redactEmbeddedSecrets(String(value ?? "").trim());
  return text.length > 4000 ? `${text.slice(0, 4000)}...<truncated>` : text;
}

function redact(input) {
  if (Array.isArray(input)) return input.map((item) => redact(item));
  if (!input || typeof input !== "object") return input;
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => {
      if (typeof value === "string") return [key, redactValue(key, value)];
      if (value && typeof value === "object") return [key, redact(value)];
      return [key, value];
    }),
  );
}

function redactCommand(command) {
  return redactEmbeddedSecrets(command).replace(
    /(--password(?:=|\s+))("[^"]+"|'[^']+'|\S+)/gi,
    "$1<redacted:password>",
  );
}

function redactValue(key, value) {
  const text = redactEmbeddedSecrets(String(value));
  if (/(password|secret|token|dsn|key|auth)$/i.test(key)) {
    return `<redacted:${key.toLowerCase()}>`;
  }
  return text;
}

function redactEmbeddedSecrets(value) {
  return value
    .replace(/https:\/\/[^@\s]+@[^/\s]*sentry\.io\/\d+/gi, "<redacted:dsn>")
    .replace(/sentry_key=[^,\s;]+/gi, "sentry_key=<redacted:key>");
}

function relativePath(path) {
  if (!path) return null;
  return relative(repoRoot, path).replace(/\\/g, "/");
}

function finish(code) {
  if (json) {
    console.log(JSON.stringify(redact(report), null, 2));
  } else {
    console.log("Shape Meet demo handoff");
    console.log(`Output: ${outputDir}`);
    for (const step of Object.values(report.steps)) {
      const state = step.skipped ? "omitido" : step.ok ? "ok" : "revisar";
      console.log(`- ${step.label}: ${state}`);
    }
    console.log(
      report.ok ? "Paquete demo listo" : "Paquete demo con pendientes",
    );
    console.log(`Manifest: ${join(outputDir, "manifest.json")}`);
  }
  process.exit(code);
}
