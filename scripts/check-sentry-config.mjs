import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const json = args.has("--json");
const outputPath = argValue("--output");
const root = resolve(argValue("--root") ?? process.cwd());
const liveCheck = args.has("--live") || args.has("--send-test-event");
const strict = args.has("--strict");
const sources = [
  ".env.local",
  "apps/admin/.env.local",
  "apps/desktop/.env.local",
  ".env.example",
];
const envByFile = new Map();
const mergedEnv = { ...process.env };
const issues = [];
const warnings = [];
const resolvedChecks = [];
const liveResults = [];

for (const source of sources) {
  const path = resolve(root, source);
  if (!existsSync(path)) continue;
  const parsed = parseEnvFile(path);
  envByFile.set(source, parsed);
  for (const [key, value] of Object.entries(parsed)) {
    if (!mergedEnv[key]) mergedEnv[key] = value;
  }
}

const checks = [
  {
    label: "admin server/API",
    source: "apps/admin/.env.local",
    keys: ["SENTRY_DSN", "NEXT_PUBLIC_SENTRY_DSN"],
  },
  {
    label: "admin browser",
    source: "apps/admin/.env.local",
    keys: ["NEXT_PUBLIC_SENTRY_DSN"],
  },
  {
    label: "desktop webview",
    source: "apps/desktop/.env.local",
    keys: ["VITE_SENTRY_DSN"],
  },
  {
    label: "desktop native",
    source: "apps/desktop/.env.local",
    keys: ["SENTRY_DSN", "VITE_SENTRY_DSN"],
  },
  {
    label: "ai sidecar",
    source: ".env.local",
    keys: ["SENTRY_DSN", "VITE_SENTRY_DSN", "NEXT_PUBLIC_SENTRY_DSN"],
    fallbackSources: ["apps/desktop/.env.local", "apps/admin/.env.local"],
  },
];

await main();

async function main() {
  for (const check of checks) {
    const found = findValue(check);
    if (!found.value) {
      issues.push(
        `${check.label}: missing ${check.keys.join(" or ")} in ${sourceList(check)}`,
      );
      continue;
    }

    const parsed = validateDsn(`${check.label} (${found.key})`, found.value);
    resolvedChecks.push({ ...found, label: check.label, parsed });
    log(
      `${check.label} ok: ${maskDsn(found.value)} via ${found.source}:${found.key}`,
    );
  }

  validateSampleRates();
  validateDebugFlags();
  warnOnProjectKeyDisagreement();

  if (liveCheck && issues.length === 0) {
    await validateLiveDsns();
  }

  if (warnings.length > 0) {
    warn("Sentry config warnings:");
    for (const warning of warnings) warn(`- ${warning}`);
  }

  const ok = issues.length === 0 && !(strict && warnings.length > 0);
  const report = buildReport(ok);

  if (!ok) {
    error("Sentry config check failed:");
    for (const issue of issues) error(`- ${issue}`);
    if (strict) {
      for (const warning of warnings) error(`- ${warning}`);
    }
  }

  if (outputPath) {
    const fullPath = resolve(outputPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (ok) {
    console.log(liveCheck ? "Sentry config live ok" : "Sentry config ok");
  }

  if (!ok) process.exit(1);
}

function parseEnvFile(path) {
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

function findValue(check) {
  const files = [check.source, ...(check.fallbackSources ?? [])];
  for (const source of files) {
    const env = envByFile.get(source);
    if (!env) continue;
    for (const key of check.keys) {
      const value = env[key]?.trim();
      if (value) return { source, key, value };
    }
  }

  for (const key of check.keys) {
    const value = process.env[key]?.trim();
    if (value) return { source: "process.env", key, value };
  }

  return { source: null, key: null, value: null };
}

function validateDsn(label, value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    issues.push(`${label}: invalid DSN URL`);
    return null;
  }

  if (url.protocol !== "https:") {
    issues.push(`${label}: DSN must use https://`);
  }
  if (!url.username) {
    issues.push(`${label}: DSN is missing public key`);
  }
  if (!url.hostname.includes("sentry.io")) {
    warnings.push(`${label}: DSN host does not look like sentry.io`);
  }
  if (!/^\/\d+\/?$/.test(url.pathname)) {
    issues.push(`${label}: DSN path must contain the numeric project id`);
  }

  return {
    protocol: url.protocol,
    host: url.host,
    publicKey: url.username,
    projectId: url.pathname.replace(/^\/+|\/+$/g, ""),
    normalized: `${url.protocol}//${url.username}@${url.host}${url.pathname.replace(/\/$/, "")}`,
  };
}

function validateSampleRates() {
  for (const key of [
    "SENTRY_TRACES_SAMPLE_RATE",
    "NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE",
    "VITE_SENTRY_TRACES_SAMPLE_RATE",
  ]) {
    const value = mergedEnv[key];
    if (!value) continue;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      issues.push(`${key} must be a number between 0 and 1`);
    }
  }
}

function validateDebugFlags() {
  for (const key of [
    "SENTRY_DEBUG",
    "NEXT_PUBLIC_SENTRY_DEBUG",
    "VITE_SENTRY_DEBUG",
  ]) {
    const value = mergedEnv[key];
    if (!value) continue;
    if (
      !["0", "1", "true", "false", "yes", "no"].includes(value.toLowerCase())
    ) {
      warnings.push(
        `${key} should be boolean-like for predictable SDK debug logs`,
      );
    }
  }
}

function warnOnProjectKeyDisagreement() {
  const groups = new Map();

  for (const check of resolvedChecks) {
    if (!check.parsed) continue;
    const groupKey = `${check.parsed.host}/${check.parsed.projectId}`;
    const group = groups.get(groupKey) ?? new Map();
    const labels = group.get(check.parsed.publicKey) ?? [];
    labels.push(`${check.label} via ${check.source}:${check.key}`);
    group.set(check.parsed.publicKey, labels);
    groups.set(groupKey, group);
  }

  for (const [project, keys] of groups) {
    if (keys.size <= 1) continue;
    const maskedKeys = [...keys.keys()].map(maskKey).join(", ");
    warnings.push(
      `multiple Sentry public keys found for ${project}: ${maskedKeys}. Run check:sentry:live to verify each key.`,
    );
  }
}

async function validateLiveDsns() {
  const unique = new Map();

  for (const check of resolvedChecks) {
    if (!check.parsed) continue;
    const item = unique.get(check.parsed.normalized) ?? {
      parsed: check.parsed,
      labels: [],
    };
    item.labels.push(`${check.label} via ${check.source}:${check.key}`);
    unique.set(check.parsed.normalized, item);
  }

  for (const item of unique.values()) {
    const label = item.labels.join(", ");
    const result = await sendSentryProbe(item.parsed);
    liveResults.push({
      ok: result.ok,
      dsn: maskParsedDsn(item.parsed),
      labels: item.labels,
      status: result.status,
      message: result.message,
    });
    if (result.ok) {
      log(`sentry live ok: ${maskParsedDsn(item.parsed)} (${label})`);
      continue;
    }
    issues.push(
      `live check failed for ${maskParsedDsn(item.parsed)} (${label}): ${result.message}`,
    );
  }
}

async function sendSentryProbe(dsn) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const endpoint = `${dsn.protocol}//${dsn.host}/api/${dsn.projectId}/store/?sentry_key=${encodeURIComponent(
    dsn.publicKey,
  )}&sentry_version=7&sentry_client=shape-meet-check/0.1`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event_id: randomUUID().replaceAll("-", ""),
        timestamp: new Date().toISOString(),
        platform: "javascript",
        logger: "shape-meet.check-sentry",
        level: "info",
        message: "Shape Meet Sentry live config check",
        environment:
          mergedEnv.SENTRY_ENVIRONMENT ??
          mergedEnv.NEXT_PUBLIC_SENTRY_ENVIRONMENT ??
          mergedEnv.VITE_SENTRY_ENVIRONMENT ??
          "development",
        tags: {
          "app.surface": "config-check",
          "shape.check": "sentry-live",
        },
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      message: response.ok
        ? "ok"
        : sentryHttpErrorMessage(response.status, text),
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function sentryHttpErrorMessage(status, text) {
  const detail = text.slice(0, 240);
  const hint = /ProjectId/i.test(text)
    ? "La clave pública y el project id de la DSN no pertenecen al mismo proyecto, o el proyecto no acepta ingesta para esa DSN. Copia de nuevo la DSN desde Project Settings > Client Keys en Sentry."
    : "";
  return [`HTTP ${status}: ${detail}`, hint].filter(Boolean).join(" ");
}

function buildReport(ok) {
  return {
    generatedAt: new Date().toISOString(),
    ok,
    live: liveCheck,
    strict,
    checks: resolvedChecks.map((check) => ({
      label: check.label,
      source: check.source,
      key: check.key,
      dsn: maskDsn(check.value),
      parsed: check.parsed
        ? {
            host: check.parsed.host,
            publicKey: maskKey(check.parsed.publicKey),
            projectId: check.parsed.projectId,
          }
        : null,
    })),
    liveResults,
    warnings: [...warnings],
    issues: [...issues],
    nextSteps: sentryNextSteps(),
  };
}

function sentryNextSteps() {
  if (issues.some((issue) => issue.includes("live check failed"))) {
    return [
      "Copia de nuevo la DSN desde Sentry Project Settings > Client Keys.",
      'Ejecuta `pnpm sentry:configure -- --dsn "https://..." --environment internal-debug --debug true`.',
      "Repite `pnpm check:sentry:live` antes del demo real.",
    ];
  }
  if (issues.length > 0) {
    return [
      'Configura Sentry con `pnpm sentry:configure -- --dsn "https://..." --environment internal-debug --debug true`.',
      "Repite `pnpm check:sentry`.",
    ];
  }
  if (liveCheck) return [];
  return ["Ejecuta `pnpm check:sentry:live` para validar ingesta real."];
}

function maskDsn(value) {
  try {
    const url = new URL(value);
    const key = url.username;
    url.username =
      key.length > 10 ? `${key.slice(0, 6)}...${key.slice(-4)}` : "***";
    return url.toString();
  } catch {
    return "<invalid>";
  }
}

function maskParsedDsn(dsn) {
  return `${dsn.protocol}//${maskKey(dsn.publicKey)}@${dsn.host}/${dsn.projectId}`;
}

function maskKey(key) {
  return key.length > 10 ? `${key.slice(0, 6)}...${key.slice(-4)}` : "***";
}

function sourceList(check) {
  return [check.source, ...(check.fallbackSources ?? []), "process.env"].join(
    ", ",
  );
}

function argValue(name) {
  const prefix = `${name}=`;
  const inline = rawArgs.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = rawArgs.indexOf(name);
  return index >= 0 ? (rawArgs[index + 1] ?? null) : null;
}

function log(message) {
  if (!json) console.log(message);
}

function warn(message) {
  if (!json) console.warn(message);
}

function error(message) {
  if (!json) console.error(message);
}
