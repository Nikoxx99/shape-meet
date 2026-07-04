import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, freemem, platform, release, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const args = process.argv.slice(2);
const outputDir = resolve(
  repoRoot,
  argValue("--output-dir") ?? join("output", "debug"),
);
const remoteEnvFile =
  argValue("--remote-env-file") ?? process.env.SHAPE_REMOTE_DEMO_ENV_FILE;
const envSources = [
  "infra/env.local.example",
  ".env.local",
  "apps/admin/.env.local",
  "apps/desktop/.env.local",
];
const envFiles = Object.fromEntries(
  envSources.map((source) => [source, readEnvFile(source)]),
);
const env = {
  ...envFiles["infra/env.local.example"],
  ...envFiles[".env.local"],
  ...envFiles["apps/admin/.env.local"],
  ...envFiles["apps/desktop/.env.local"],
  ...process.env,
};
const adminUrl = (
  env.SHAPE_DEMO_API_URL ??
  env.VITE_SHAPE_API_URL ??
  "http://localhost:13000"
).replace(/\/$/, "");
const appUrl = (
  env.SHAPE_DEMO_APP_URL ??
  env.VITE_SHAPE_MEETING_URL ??
  env.VITE_SHAPE_APP_URL ??
  "http://localhost:1420"
).replace(/\/$/, "");
const aiUrl = (
  env.SHAPE_DEMO_AI_URL ??
  env.VITE_SHAPE_AI_SERVICE_URL ??
  "http://127.0.0.1:7851"
).replace(/\/$/, "");

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function main() {
  const generatedAt = new Date().toISOString();
  mkdirSync(outputDir, { recursive: true });

  const [adminHealth, desktop, aiHealth, aiDiagnostics, nvidia] =
    await Promise.all([
      inspectEndpoint(`${adminUrl}/api/health`),
      inspectEndpoint(appUrl),
      inspectEndpoint(`${aiUrl}/health`),
      inspectEndpoint(`${aiUrl}/diagnostics`),
      inspectNvidia(),
    ]);

  const docker = inspectDocker();
  const git = inspectGit();
  const sentry = inspectSentry();
  const modelDoctor = inspectModelDoctor();
  const demoStatus = inspectDemoStatus();

  const payload = redact({
    generatedAt,
    repo: {
      name: "shape-meet",
      root: repoRoot,
      git,
    },
    machine: {
      platform: platform(),
      arch: arch(),
      osRelease: release(),
      cpuModel: cpus()[0]?.model ?? "unknown",
      cpuCount: cpus().length,
      memoryMb: {
        total: Math.round(totalmem() / 1024 / 1024),
        free: Math.round(freemem() / 1024 / 1024),
      },
      nvidia,
    },
    demo: {
      adminUrl,
      appUrl,
      aiUrl,
      endpoints: {
        adminHealth,
        desktop,
        aiHealth,
        aiDiagnostics,
      },
      ready: {
        admin: adminHealth.ok && adminHealth.data?.database === "ok",
        desktop: desktop.ok,
        ai: aiHealth.ok && aiHealth.data?.status === "ready",
        aiDemo:
          aiHealth.ok &&
          aiHealth.data?.mode === "adapter-contract" &&
          hasRunningProcessor(aiHealth.data, "video") &&
          hasRunningProcessor(aiHealth.data, "audio"),
      },
      status: demoStatus,
    },
    docker,
    observability: {
      sentry,
    },
    modelRuntime: modelDoctor,
    envFiles: summarizeEnvFiles(),
  });

  const safeNow = generatedAt.replace(/[:.]/g, "-");
  const outputPath = join(outputDir, `shape-demo-debug-${safeNow}.json`);
  writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);

  console.log(`Debug bundle escrito: ${outputPath}`);
  printSummary(payload);
}

async function inspectEndpoint(url) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    const data = parseJson(text);

    return {
      ok: response.ok,
      url,
      status: response.status,
      durationMs: Date.now() - startedAt,
      contentType: response.headers.get("content-type"),
      data,
      textPreview: data ? undefined : text.slice(0, 600),
    };
  } catch (error) {
    return {
      ok: false,
      url,
      status: null,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function inspectNvidia() {
  const result = runCommand("nvidia-smi", [
    "--query-gpu=name,memory.total,memory.free,driver_version",
    "--format=csv,noheader,nounits",
  ]);

  return {
    available: result.status === 0 && Boolean(result.stdout.trim()),
    command: result.command,
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function inspectDocker() {
  const composeArgs = [
    "compose",
    "-p",
    "shape-meet-local",
    "-f",
    "infra/docker-compose.coolify.yml",
    "ps",
    "--format",
    "json",
  ];
  const result = runCommand("docker", composeArgs, { timeout: 15000 });
  const parsed = parseDockerJson(result.stdout);

  return {
    available: result.status === 0,
    command: result.command,
    status: result.status,
    services: parsed,
    stdoutPreview: parsed ? undefined : result.stdout.slice(0, 2000),
    stderr: result.stderr.trim(),
  };
}

function inspectGit() {
  return {
    branch: runGit(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim(),
    commit: runGit(["rev-parse", "--short", "HEAD"]).stdout.trim(),
    statusShort: runGit(["status", "--short"]).stdout.trim(),
    lastCommit: runGit(["log", "-1", "--pretty=%h %s"]).stdout.trim(),
  };
}

function inspectSentry() {
  const result = runPnpm(["check:sentry", "--", "--json"]);
  const parsed = parseJson(result.stdout);

  return {
    ok: result.status === 0 && parsed?.ok === true,
    command: result.command,
    status: result.status,
    report: parsed,
    stdoutPreview: parsed ? undefined : result.stdout.slice(0, 2000),
    stderr: result.stderr.trim(),
  };
}

function inspectModelDoctor() {
  const result = runPnpm(["models:doctor", "--", "--json"]);
  const parsed = parseJson(result.stdout);

  return {
    ok: result.status === 0 && parsed?.ok === true,
    command: result.command,
    status: result.status,
    report: parsed,
    stdoutPreview: parsed ? undefined : result.stdout.slice(0, 2000),
    stderr: result.stderr.trim(),
  };
}

function inspectDemoStatus() {
  const commandArgs = ["demo:status", "--", "--json"];
  if (remoteEnvFile) commandArgs.push("--remote-env-file", remoteEnvFile);
  forwardStatusFlag(commandArgs, "--remote-api-flow");
  forwardStatusFlag(commandArgs, "--api-flow");
  forwardStatusFlag(commandArgs, "--remote-identity-flow");
  forwardStatusFlag(commandArgs, "--identity-flow");
  forwardStatusFlag(commandArgs, "--skip-network");
  forwardStatusFlag(commandArgs, "--skip-turn-auth");
  forwardStatusFlag(commandArgs, "--skip-livekit-handshake");
  forwardStatusValue(commandArgs, "--remote-timeout-ms");

  const result = runPnpm(commandArgs, { timeout: 120000 });
  const parsed = parseJson(result.stdout);

  return {
    ok: result.status === 0 && parsed?.ok === true,
    command: result.command,
    status: result.status,
    report: parsed,
    stdoutPreview: parsed ? undefined : result.stdout.slice(0, 2000),
    stderr: result.stderr.trim(),
  };
}

function runGit(args) {
  return runCommand("git", args);
}

function runPnpm(args, options = {}) {
  return runCommand(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, {
    timeout: options.timeout ?? 30000,
  });
}

function runCommand(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: options.timeout ?? 10000,
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

function summarizeEnvFiles() {
  return Object.fromEntries(
    Object.entries(envFiles).map(([source, values]) => [
      source,
      {
        exists: existsSync(join(repoRoot, source)),
        keys: Object.keys(values).sort(),
        values: valuesWithSecretsRedacted(values),
      },
    ]),
  );
}

function valuesWithSecretsRedacted(values) {
  return Object.fromEntries(
    Object.entries(values)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, redactValue(key, value)]),
  );
}

function hasRunningProcessor(data, id) {
  return data?.diagnostics?.managedProcessors?.some(
    (processor) => processor.id === id && processor.status === "running",
  );
}

function parseJson(value) {
  if (!value?.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseDockerJson(value) {
  const trimmed = value.trim();
  if (!trimmed) return [];

  const parsed = parseJson(trimmed);
  if (parsed) return Array.isArray(parsed) ? parsed : [parsed];

  const services = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const current = parseJson(line);
    if (current) services.push(current);
  }
  return services.length > 0 ? services : null;
}

function readEnvFile(path) {
  const fullPath = join(repoRoot, path);
  if (!existsSync(fullPath)) return {};
  const values = {};

  for (const rawLine of readFileSync(fullPath, "utf8").split(/\r?\n/)) {
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
  const text = redactEmbeddedSecrets(String(value));
  if (!text) return text;
  if (isSensitiveKey(key)) return `<redacted:${redactedKind(key)}>`;
  if (looksLikeDsn(text)) return "<redacted:dsn>";
  if (looksLikeCredentialedUrl(text)) return redactUrl(text);
  return text.length > 2000 ? `${text.slice(0, 2000)}...<truncated>` : text;
}

function isSensitiveKey(key) {
  return (
    /(auth|cookie|dsn|key|password|private|secret|token|url)$/i.test(key) &&
    !isPublicSafeUrlKey(key)
  );
}

function isPublicSafeUrlKey(key) {
  return /^(adminUrl|aiUrl|appUrl|url|.*_URL|.*Url)$/i.test(key);
}

function redactedKind(key) {
  const lower = key.toLowerCase();
  if (lower.includes("dsn")) return "dsn";
  if (lower.includes("password")) return "password";
  if (lower.includes("token")) return "token";
  if (lower.includes("secret")) return "secret";
  if (lower.includes("auth")) return "auth";
  if (lower.includes("key")) return "key";
  return "secret";
}

function looksLikeDsn(value) {
  return /^https:\/\/[^@\s]+@[^/\s]*sentry\.io\/\d+/i.test(value);
}

function redactEmbeddedSecrets(value) {
  return value
    .replace(/https:\/\/[^@\s]+@[^/\s]*sentry\.io\/\d+/gi, "<redacted:dsn>")
    .replace(/sentry_key=[^,\s;]+/gi, "sentry_key=<redacted:key>");
}

function looksLikeCredentialedUrl(value) {
  try {
    const url = new URL(value);
    return Boolean(url.username || url.password);
  } catch {
    return false;
  }
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    if (url.username) url.username = "<redacted>";
    if (url.password) url.password = "<redacted>";
    return url.toString();
  } catch {
    return "<redacted:url>";
  }
}

function printSummary(payload) {
  const ready = payload.demo.ready;
  const status = payload.demo.status.report;
  console.log("Resumen:");
  console.log(`- Admin/API: ${ready.admin ? "ok" : "revisar"}`);
  console.log(`- Desktop web: ${ready.desktop ? "ok" : "revisar"}`);
  console.log(`- IA local: ${ready.ai ? "ok" : "revisar"}`);
  console.log(`- IA demo: ${ready.aiDemo ? "ok" : "revisar"}`);
  if (status?.readiness) {
    console.log(`- Demo status: ${status.readiness.demoPercent ?? 0}%`);
    console.log(`- Remoto/Coolify: ${status.readiness.remoteDeployment}`);
    console.log(`- Modelos reales: ${status.readiness.realModelDemo}`);
  }
  console.log(
    `- Sentry: ${payload.observability.sentry.ok ? "ok" : "revisar"}`,
  );
  console.log(
    `- Modelos: ${payload.modelRuntime.ok ? "ok" : "revisar warnings"}`,
  );
}

function forwardStatusFlag(target, name) {
  if (args.includes(name)) target.push(name);
}

function forwardStatusValue(target, name) {
  const value = argValue(name);
  if (value) target.push(name, value);
}

function argValue(name) {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);

  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}
