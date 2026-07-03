import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const envFileArg = args.find((arg) => !arg.startsWith("--")) ?? "infra/env.local.example";
const envFile = resolve(envFileArg);
const composeFile = resolve("infra/docker-compose.coolify.yml");
const issues = [];
const warnings = [];

if (!existsSync(envFile)) {
  fail(`env file not found: ${envFile}`);
}

const env = parseEnvFile(envFile);

for (const key of [
  "POSTGRES_PASSWORD",
  "REDIS_PASSWORD",
  "AUTH_SESSION_SECRET",
  "HOST_BOOTSTRAP_EMAIL",
  "HOST_BOOTSTRAP_PASSWORD",
  "LIVEKIT_URL",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
  "LIVEKIT_TURN_DOMAIN",
  "LIVEKIT_RTC_TCP_PORT",
  "LIVEKIT_RTC_UDP_PORT",
  "LIVEKIT_TURN_UDP_PORT",
  "LIVEKIT_TURN_TLS_PORT",
  "LIVEKIT_TURN_RELAY_RANGE_START",
  "LIVEKIT_TURN_RELAY_RANGE_END",
  "NEXT_PUBLIC_APP_URL",
  "ADMIN_HTTP_PORT",
]) {
  requireEnv(key);
}

for (const key of [
  "POSTGRES_PASSWORD",
  "REDIS_PASSWORD",
  "AUTH_SESSION_SECRET",
  "HOST_BOOTSTRAP_PASSWORD",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
]) {
  if (isPlaceholder(env[key])) {
    const message = `${key} still looks like a placeholder`;
    if (strict) issues.push(message);
    else warnings.push(message);
  }
}

const appUrl = parseUrl("NEXT_PUBLIC_APP_URL");
const livekitUrl = parseUrl("LIVEKIT_URL");
const turnDomain = env.LIVEKIT_TURN_DOMAIN;
const rtcTcpPort = parsePort("LIVEKIT_RTC_TCP_PORT");
const rtcUdpPort = parsePort("LIVEKIT_RTC_UDP_PORT");
const turnUdpPort = parsePort("LIVEKIT_TURN_UDP_PORT");
const turnTlsPort = parsePort("LIVEKIT_TURN_TLS_PORT");
const relayStart = parsePort("LIVEKIT_TURN_RELAY_RANGE_START");
const relayEnd = parsePort("LIVEKIT_TURN_RELAY_RANGE_END");
parsePort("ADMIN_HTTP_PORT");

if (appUrl?.protocol === "https:" && livekitUrl?.protocol !== "wss:") {
  issues.push("LIVEKIT_URL must use wss:// when NEXT_PUBLIC_APP_URL uses https://");
}

if (livekitUrl?.hostname && livekitUrl.hostname === turnDomain) {
  issues.push("LIVEKIT_URL host and LIVEKIT_TURN_DOMAIN must be separate domains");
}

if (appUrl?.hostname && appUrl.hostname === turnDomain) {
  issues.push("NEXT_PUBLIC_APP_URL host and LIVEKIT_TURN_DOMAIN must be separate domains");
}

if (new Set([rtcTcpPort, rtcUdpPort, turnUdpPort, turnTlsPort].filter(Boolean)).size < 4) {
  issues.push("LiveKit RTC/TURN ports must be distinct");
}

if (relayStart && relayEnd && relayEnd < relayStart) {
  issues.push("LIVEKIT_TURN_RELAY_RANGE_END must be greater than or equal to START");
}

if (relayStart && relayEnd && relayEnd - relayStart < 100) {
  warnings.push("TURN relay range is narrow; keep at least 100 UDP ports for multi-participant tests");
}

const externalTls = parseBoolean(env.LIVEKIT_TURN_EXTERNAL_TLS ?? "true");
if (externalTls && turnTlsPort && turnTlsPort !== 443) {
  warnings.push(
    "LIVEKIT_TURN_EXTERNAL_TLS=true with LIVEKIT_TURN_TLS_PORT not 443 requires an L4/TCP load balancer in front of turn domain",
  );
}

if (!externalTls) {
  warnings.push(
    "LIVEKIT_TURN_EXTERNAL_TLS=false requires cert_file/key_file support; this compose is intended for external TLS termination",
  );
}

const compose = spawnSync(
  "docker",
  ["compose", "--env-file", envFile, "-f", composeFile, "config"],
  { encoding: "utf8" },
);

if (compose.error?.code === "ENOENT") {
  warnings.push("docker compose not found; skipped rendered compose validation");
} else if (compose.status !== 0) {
  issues.push(`docker compose config failed:\n${compose.stderr || compose.stdout}`);
} else {
  const rendered = compose.stdout;
  for (const expected of ["shape-admin", "shape-livekit", "shape-postgres", "shape-redis"]) {
    if (!rendered.includes(expected)) issues.push(`rendered compose is missing ${expected}`);
  }
  if (!rendered.includes("turn:") || !rendered.includes("enabled: true")) {
    issues.push("rendered LiveKit config does not show TURN enabled");
  }
}

if (warnings.length > 0) {
  console.warn("Coolify config warnings:");
  for (const warning of warnings) console.warn(`- ${warning}`);
}

if (issues.length > 0) {
  console.error("Coolify config check failed:");
  for (const issue of issues) console.error(`- ${issue}`);
  process.exit(1);
}

console.log(`Coolify config ok: ${envFileArg}`);

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

function requireEnv(key) {
  if (!env[key]) issues.push(`missing required env: ${key}`);
}

function parseUrl(key) {
  if (!env[key]) return null;
  try {
    return new URL(env[key]);
  } catch {
    issues.push(`${key} is not a valid URL`);
    return null;
  }
}

function parsePort(key) {
  if (!env[key]) return null;
  const port = Number(env[key]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    issues.push(`${key} must be an integer port between 1 and 65535`);
    return null;
  }
  return port;
}

function parseBoolean(value) {
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function isPlaceholder(value) {
  if (!value) return true;
  return [
    /^replace/i,
    /change-me/i,
    /^secret$/i,
    /^devkey$/i,
    /^shape_meet$/i,
    /^shape_redis$/i,
    /^local-debug/i,
  ].some((pattern) => pattern.test(value));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
