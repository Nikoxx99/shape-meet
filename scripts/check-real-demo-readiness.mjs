import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const args = process.argv.slice(2);
const json = args.includes("--json");
const strict = args.includes("--strict");
const skipSentry = args.includes("--skip-sentry");
const skipModelDoctor = args.includes("--skip-model-doctor");
const skipModelPreflight = args.includes("--skip-model-preflight");
const forceModelPreflight = args.includes("--force-model-preflight");
const includeDesktop = args.includes("--include-desktop");
const requireRealModels =
  args.includes("--require-real-models") || args.includes("--real-models");
const runtimeEnvFile =
  argValue("--env-file") ?? process.env.SHAPE_AI_RUNTIME_ENV_FILE ?? null;
const remoteEnvFile = argValue("--remote-env-file");
const profile =
  argValue("--profile") ?? process.env.SHAPE_MODEL_WORKSTATION_PROFILE;
const timeoutMs = argValue("--timeout-ms");
const outputPath = argValue("--output");

const report = {
  generatedAt: new Date().toISOString(),
  ok: false,
  readyForRealDemo: false,
  strict,
  requireRealModels,
  runtimeEnvFile,
  remoteEnvFile,
  profile: profile ?? null,
  steps: {},
  nextSteps: [],
};

try {
  await main();
} catch (error) {
  report.steps.unhandled = {
    ok: false,
    label: "Error no controlado",
    error: error instanceof Error ? error.message : String(error),
  };
  finish(1);
}

async function main() {
  report.steps.sentry = skipSentry
    ? skipped("Sentry", "omitido por --skip-sentry")
    : runSentryCheck();

  report.steps.desktop = includeDesktop
    ? runDesktopDoctor()
    : skipped("Desktop release", "usa --include-desktop para validarlo");

  report.steps.modelDoctor = skipModelDoctor
    ? skipped("Modelos doctor", "omitido por --skip-model-doctor")
    : runModelDoctor();

  report.steps.realModels = inspectRealModels();
  report.steps.modelPreflight = runModelPreflight();
  report.steps.remoteDemo = remoteEnvFile
    ? runRemoteDemoCheck()
    : skipped("Demo remoto", "pasa --remote-env-file para validarlo");

  collectNextSteps();
  report.ok = Object.values(report.steps).every(
    (step) => step.skipped || step.ok,
  );
  report.readyForRealDemo = realDemoReady();
  finish(report.ok ? 0 : 1);
}

function runSentryCheck() {
  const commandArgs = ["check:sentry", "--"];
  if (strict) commandArgs.push("--strict");
  return commandStep("Sentry", commandArgs);
}

function runDesktopDoctor() {
  const commandArgs = ["desktop:doctor", "--"];
  if (strict) commandArgs.push("--strict");
  return commandStep("Desktop release", commandArgs);
}

function runModelDoctor() {
  const commandArgs = ["models:doctor", "--", "--json"];
  if (runtimeEnvFile) commandArgs.push("--env-file", runtimeEnvFile);
  if (profile) commandArgs.push("--profile", profile);
  if (strict) commandArgs.push("--strict");

  const step = commandStep("Modelos doctor", commandArgs, { parseJson: true });
  const modelReport = step.report;
  if (modelReport) {
    step.ok = step.status === 0 && modelReport.ok === true;
    step.nextSteps = Array.isArray(modelReport.nextSteps)
      ? modelReport.nextSteps
      : [];
    step.warnings = Array.isArray(modelReport.warnings)
      ? modelReport.warnings
      : [];
    step.issues = Array.isArray(modelReport.issues) ? modelReport.issues : [];
  }
  return step;
}

function runModelPreflight() {
  if (skipModelPreflight) {
    return skipped("Modelos preflight", "omitido por --skip-model-preflight");
  }

  const doctor = report.steps.modelDoctor;
  if (doctor && !doctor.skipped && !doctor.ok && !forceModelPreflight) {
    return skipped(
      "Modelos preflight",
      "omitido porque models:doctor no paso; usa --force-model-preflight para forzarlo",
    );
  }

  const commandArgs = ["models:preflight", "--", "--json"];
  if (runtimeEnvFile) commandArgs.push("--env-file", runtimeEnvFile);
  if (timeoutMs) commandArgs.push("--timeout-ms", timeoutMs);
  if (strict) commandArgs.push("--strict");
  appendForwardedArg(commandArgs, "--frame");
  appendForwardedArg(commandArgs, "--identity");
  appendForwardedArg(commandArgs, "--clean-plate");
  appendForwardedArg(commandArgs, "--audio");
  if (args.includes("--skip-video")) commandArgs.push("--skip-video");
  if (args.includes("--skip-audio")) commandArgs.push("--skip-audio");

  const step = commandStep("Modelos preflight", commandArgs, {
    parseJson: true,
    timeout: positiveInteger(timeoutMs, 90_000),
  });
  const preflight = step.report?.preflight;
  if (preflight) {
    step.ok = step.status === 0 && preflight.status === "passed";
    step.statusLabel = preflight.status;
    step.checks = Array.isArray(preflight.checks) ? preflight.checks : [];
    step.warnings = Array.isArray(preflight.warnings) ? preflight.warnings : [];
  }
  return step;
}

function runRemoteDemoCheck() {
  if (!existsSync(resolve(repoRoot, remoteEnvFile))) {
    return {
      ok: false,
      label: "Demo remoto",
      command: null,
      error: `No existe --remote-env-file: ${remoteEnvFile}`,
    };
  }

  const commandArgs = ["demo:remote:check", "--", "--env-file", remoteEnvFile];
  if (strict) commandArgs.push("--strict");
  return commandStep("Demo remoto", commandArgs, { timeout: 30_000 });
}

function inspectRealModels() {
  const envPath =
    runtimeEnvFile ??
    report.steps.modelDoctor?.report?.envFile ??
    process.env.SHAPE_AI_RUNTIME_ENV_FILE ??
    null;
  const env = envPath ? readEnvFile(resolve(repoRoot, envPath)) : {};
  const issues = [];
  const warnings = [];
  const nextSteps = [];
  const passthrough = /^(1|true|yes|on)$/i.test(
    env.SHAPE_WRAPPER_PASSTHROUGH ?? "",
  );
  const videoFrameCommand = env.SHAPE_VIDEO_FRAME_COMMAND?.trim();
  const faceCommand = env.SHAPE_FACE_COMMAND?.trim();
  const backgroundCommand = env.SHAPE_BACKGROUND_COMMAND?.trim();
  const audioChunkCommand = env.SHAPE_AUDIO_CHUNK_COMMAND?.trim();
  const voiceCommand = env.SHAPE_VOICE_COMMAND?.trim();

  if (!envPath || !existsSync(resolve(repoRoot, envPath))) {
    issues.push("No hay runtime env para validar modelos reales.");
    nextSteps.push(
      "Genera runtime real con `pnpm models:runtime -- --profile windows-nvidia --preset local-wrappers`.",
    );
  }

  if (passthrough) {
    issues.push(
      "SHAPE_WRAPPER_PASSTHROUGH=true: el preflight valida contrato, no modelos reales.",
    );
    nextSteps.push(
      "Desactiva passthrough cuando FaceFusion, BackgroundMattingV2 y vcclient000 estén instalados.",
    );
  }

  if (videoFrameCommand) {
    requirePlaceholder(
      videoFrameCommand,
      "SHAPE_VIDEO_FRAME_COMMAND",
      "identity",
      issues,
    );
    requirePlaceholder(
      videoFrameCommand,
      "SHAPE_VIDEO_FRAME_COMMAND",
      "clean_plate",
      issues,
    );
  } else {
    if (!faceCommand) {
      issues.push("Falta SHAPE_FACE_COMMAND para face swap real.");
      nextSteps.push(
        "Configura FaceFusion con `--facefusion-dir`, `--facefusion-python` o un `--face-command` real.",
      );
    }
    if (!backgroundCommand) {
      issues.push("Falta SHAPE_BACKGROUND_COMMAND para cambio de fondo real.");
      nextSteps.push(
        "Configura BackgroundMattingV2 con `--bmv2-repo-dir`, `--bmv2-checkpoint` y `--bmv2-python`.",
      );
    }
  }

  if (faceCommand?.includes("facefusion_frame.py")) {
    if (!env.FACEFUSION_COMMAND_TEMPLATE && !env.FACEFUSION_DIR) {
      issues.push(
        "Wrapper FaceFusion activo pero FACEFUSION_DIR no está configurado.",
      );
    }
  }

  if (backgroundCommand?.includes("backgroundmattingv2_frame.py")) {
    if (!env.BMV2_COMMAND_TEMPLATE && !env.BMV2_REPO_DIR) {
      issues.push(
        "Wrapper BackgroundMattingV2 activo pero BMV2_REPO_DIR no está configurado.",
      );
    }
    if (!env.BMV2_COMMAND_TEMPLATE && !env.BMV2_MODEL_CHECKPOINT) {
      issues.push(
        "Wrapper BackgroundMattingV2 activo pero BMV2_MODEL_CHECKPOINT no está configurado.",
      );
    }
  }

  if (!audioChunkCommand && !voiceCommand) {
    issues.push("Falta SHAPE_VOICE_COMMAND o SHAPE_AUDIO_CHUNK_COMMAND.");
    nextSteps.push(
      "Arranca vcclient000/w-okada y configura VCCLIENT000_HTTP_ENDPOINT o un comando de voz real.",
    );
  }

  if (voiceCommand?.includes("vcclient000_chunk.py")) {
    if (!env.VCCLIENT000_CHUNK_COMMAND && !env.VCCLIENT000_HTTP_ENDPOINT) {
      issues.push(
        "Wrapper vcclient000 activo pero no hay VCCLIENT000_HTTP_ENDPOINT ni VCCLIENT000_CHUNK_COMMAND.",
      );
    }
  }

  if (!passthrough && issues.length === 0) {
    warnings.push(
      "La configuración declara modelos reales; valida calidad visual/audio en la estación final.",
    );
  }

  const realModelsConfigured = issues.length === 0 && !passthrough;
  return {
    ok: requireRealModels ? realModelsConfigured : true,
    label: "Modelos reales",
    statusLabel: realModelsConfigured
      ? "configurado"
      : requireRealModels
        ? "pendiente"
        : "contrato/passthrough permitido",
    realModelsConfigured,
    requireRealModels,
    envFile: envPath,
    issues,
    warnings,
    nextSteps: [...new Set(nextSteps)],
  };
}

function commandStep(label, commandArgs, options = {}) {
  const result = runPnpm(commandArgs, options);
  const parsed = options.parseJson ? parseJson(result.stdout) : null;
  return {
    ok: result.status === 0,
    label,
    command: result.command,
    status: result.status,
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
    maxBuffer: 10 * 1024 * 1024,
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

function collectNextSteps() {
  const steps = [];
  for (const step of Object.values(report.steps)) {
    if (Array.isArray(step.nextSteps)) steps.push(...step.nextSteps);
    if (Array.isArray(step.issues)) steps.push(...step.issues);
    if (step.error) steps.push(step.error);
  }
  report.nextSteps = [...new Set(steps)].slice(0, 12);
}

function finish(code) {
  if (outputPath) {
    const fullPath = resolve(repoRoot, outputPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, `${JSON.stringify(redact(report), null, 2)}\n`);
  }

  if (json) {
    console.log(JSON.stringify(redact(report), null, 2));
  } else {
    printHuman(redact(report));
  }

  process.exit(code);
}

function printHuman(currentReport) {
  console.log("Shape Meet real demo readiness");
  console.log(`Generado: ${currentReport.generatedAt}`);
  printStep(currentReport.steps.sentry);
  printStep(currentReport.steps.desktop);
  printStep(currentReport.steps.modelDoctor);
  printStep(currentReport.steps.realModels);
  printStep(currentReport.steps.modelPreflight);
  printStep(currentReport.steps.remoteDemo);

  if (currentReport.nextSteps.length > 0) {
    console.log("Siguientes pasos:");
    for (const step of currentReport.nextSteps) console.log(`- ${step}`);
  }

  if (outputPath) console.log(`Reporte JSON: ${resolve(repoRoot, outputPath)}`);
  if (currentReport.readyForRealDemo) {
    console.log("Demo real listo");
  } else if (currentReport.ok) {
    console.log(
      "Checks solicitados ok; falta preflight real para demo completa",
    );
  } else {
    console.log("Demo real requiere ajustes");
  }
}

function printStep(step) {
  if (!step) return;
  const state = step.skipped
    ? "omitido"
    : step.label === "Modelos reales" && step.realModelsConfigured !== true
      ? step.requireRealModels
        ? "revisar"
        : "pendiente"
      : step.ok
        ? "ok"
        : "revisar";
  const details = step.reason ?? step.statusLabel ?? step.error ?? "";
  console.log(`- ${step.label}: ${state}${details ? ` (${details})` : ""}`);
}

function parseJson(value) {
  const trimmed = value.trim();
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

function appendForwardedArg(target, name) {
  const value = argValue(name);
  if (value) target.push(name, value);
}

function realDemoReady() {
  const { sentry, modelDoctor, realModels, modelPreflight, remoteDemo } =
    report.steps;
  if (!sentry?.ok || sentry.skipped) return false;
  if (!modelDoctor?.ok || modelDoctor.skipped) return false;
  if (!realModels?.ok || realModels.realModelsConfigured !== true) return false;
  if (!modelPreflight?.ok || modelPreflight.skipped) return false;
  if (remoteEnvFile && (!remoteDemo?.ok || remoteDemo.skipped)) return false;
  return true;
}

function requirePlaceholder(command, label, placeholder, issues) {
  if (!command.includes(`{${placeholder}}`)) {
    issues.push(`${label} debe incluir {${placeholder}} para demo real.`);
  }
}

function argValue(name) {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);

  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function trimOutput(value) {
  const text = String(value ?? "").trim();
  return text.length > 3000 ? `${text.slice(0, 3000)}...<truncated>` : text;
}

function readEnvFile(path) {
  if (!path || !existsSync(path)) return {};
  const values = {};

  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;
    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }

  return values;
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

function redactValue(key, value) {
  const text = String(value);
  if (/(dsn|password|private|secret|token|auth|key)$/i.test(key)) {
    return `<redacted:${key.toLowerCase()}>`;
  }
  return text
    .replace(/https:\/\/[^@\s]+@[^/\s]*sentry\.io\/\d+/gi, "<redacted:dsn>")
    .replace(/sentry_key=[^,\s;]+/gi, "sentry_key=<redacted:key>");
}
