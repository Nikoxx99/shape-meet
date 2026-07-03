import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

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

for (const source of sources) {
  const path = resolve(source);
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

for (const check of checks) {
  const found = findValue(check);
  if (!found.value) {
    issues.push(`${check.label}: missing ${check.keys.join(" or ")} in ${sourceList(check)}`);
    continue;
  }

  validateDsn(`${check.label} (${found.key})`, found.value);
  console.log(`${check.label} ok: ${maskDsn(found.value)} via ${found.source}:${found.key}`);
}

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

for (const key of ["SENTRY_DEBUG", "NEXT_PUBLIC_SENTRY_DEBUG", "VITE_SENTRY_DEBUG"]) {
  const value = mergedEnv[key];
  if (!value) continue;
  if (!["0", "1", "true", "false", "yes", "no"].includes(value.toLowerCase())) {
    warnings.push(`${key} should be boolean-like for predictable SDK debug logs`);
  }
}

if (warnings.length > 0) {
  console.warn("Sentry config warnings:");
  for (const warning of warnings) console.warn(`- ${warning}`);
}

if (issues.length > 0) {
  console.error("Sentry config check failed:");
  for (const issue of issues) console.error(`- ${issue}`);
  process.exit(1);
}

console.log("Sentry config ok");

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
    return;
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
}

function maskDsn(value) {
  try {
    const url = new URL(value);
    const key = url.username;
    url.username = key.length > 10 ? `${key.slice(0, 6)}...${key.slice(-4)}` : "***";
    return url.toString();
  } catch {
    return "<invalid>";
  }
}

function sourceList(check) {
  return [check.source, ...(check.fallbackSources ?? []), "process.env"].join(", ");
}
