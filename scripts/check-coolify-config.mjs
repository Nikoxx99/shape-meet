import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const envFileArg =
  args.find((arg) => !arg.startsWith("--")) ?? "infra/env.local.example";
const envFile = resolve(envFileArg);
const composeFile = resolve("infra/docker-compose.coolify.yml");
const issues = [];
const warnings = [];
const DESKTOP_CORS_ORIGINS = [
  "tauri://localhost",
  "https://tauri.localhost",
  "http://tauri.localhost",
];

if (!existsSync(envFile)) {
  fail(`env file not found: ${envFile}`);
}

const env = parseEnvFile(envFile);

for (const key of [
  "POSTGRES_PASSWORD",
  "REDIS_PASSWORD",
  "AUTH_SESSION_SECRET",
  "CORS_ORIGIN",
  "RUN_SEED",
  "SHAPE_DEBUG_ERRORS",
  "HOST_BOOTSTRAP_EMAIL",
  "HOST_BOOTSTRAP_PASSWORD",
  "LIVEKIT_URL",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
  "LIVEKIT_USE_EXTERNAL_IP",
  "LIVEKIT_TURN_DOMAIN",
  "LIVEKIT_TURN_REALM",
  "LIVEKIT_TURN_SHARED_SECRET",
  "LIVEKIT_TURN_TTL_SECONDS",
  "LIVEKIT_TURN_EXTERNAL_IP",
  "LIVEKIT_STUN_SERVER",
  "LIVEKIT_RTC_TCP_PORT",
  "LIVEKIT_RTC_UDP_PORT",
  "LIVEKIT_TURN_UDP_PORT",
  "LIVEKIT_TURN_TLS_PORT",
  "LIVEKIT_TURN_RELAY_RANGE_START",
  "LIVEKIT_TURN_RELAY_RANGE_END",
  "NEXT_PUBLIC_APP_URL",
  "ADMIN_HTTP_PORT",
  "VITE_SHAPE_API_URL",
  "VITE_SHAPE_APP_URL",
  "VITE_SHAPE_MEETING_URL",
  "VITE_SHAPE_DEMO_DATA",
  "VITE_SHAPE_HOST_IDENTIFIER",
  "SHAPE_ARTIFACT_STORAGE_DIR",
  "SHAPE_ARTIFACT_MAX_BYTES",
  "SENTRY_ENVIRONMENT",
  "NEXT_PUBLIC_SENTRY_ENVIRONMENT",
  "SENTRY_RELEASE",
  "NEXT_PUBLIC_SENTRY_RELEASE",
  "SENTRY_TRACES_SAMPLE_RATE",
  "NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE",
  "SENTRY_DEBUG",
  "NEXT_PUBLIC_SENTRY_DEBUG",
  "VITE_SENTRY_ENVIRONMENT",
  "VITE_SENTRY_RELEASE",
  "VITE_SENTRY_TRACES_SAMPLE_RATE",
  "VITE_SENTRY_DEBUG",
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
  "LIVEKIT_TURN_SHARED_SECRET",
  "LIVEKIT_TURN_EXTERNAL_IP",
]) {
  if (isPlaceholder(env[key])) {
    const message = `${key} still looks like a placeholder`;
    if (strict) issues.push(message);
    else warnings.push(message);
  }
}

const appUrl = parseUrl("NEXT_PUBLIC_APP_URL");
const livekitUrl = parseUrl("LIVEKIT_URL");
const desktopApiUrl = parseUrl("VITE_SHAPE_API_URL");
const desktopAppUrl = parseUrl("VITE_SHAPE_APP_URL");
const meetingUrl = parseUrl("VITE_SHAPE_MEETING_URL");
const corsOrigins = parseCorsOrigins("CORS_ORIGIN");
const turnDomain = env.LIVEKIT_TURN_DOMAIN;
const turnExternalIp = env.LIVEKIT_TURN_EXTERNAL_IP;
const livekitNodeIp = env.LIVEKIT_NODE_IP;
const livekitUseExternalIp = parseBoolean("LIVEKIT_USE_EXTERNAL_IP");
const rtcTcpPort = parsePort("LIVEKIT_RTC_TCP_PORT");
const rtcUdpPort = parsePort("LIVEKIT_RTC_UDP_PORT");
const turnUdpPort = parsePort("LIVEKIT_TURN_UDP_PORT");
const turnTlsPort = parsePort("LIVEKIT_TURN_TLS_PORT");
const livekitHttpPort = parsePort("LIVEKIT_HTTP_PORT");
const adminHttpPort = parsePort("ADMIN_HTTP_PORT");
const relayStart = parsePort("LIVEKIT_TURN_RELAY_RANGE_START");
const relayEnd = parsePort("LIVEKIT_TURN_RELAY_RANGE_END");
const turnTtlSeconds = parsePositiveInteger("LIVEKIT_TURN_TTL_SECONDS");
parsePositiveInteger("SHAPE_ARTIFACT_MAX_BYTES");
parseBoolean("RUN_SEED");
parseBoolean("SHAPE_DEBUG_ERRORS");
parseOptionalBoolean("LIVEKIT_ENABLE_LOOPBACK_CANDIDATE");
parseBoolean("VITE_SHAPE_DEMO_DATA");
parseBoolean("SENTRY_DEBUG");
parseBoolean("NEXT_PUBLIC_SENTRY_DEBUG");
parseBoolean("VITE_SENTRY_DEBUG");
parseSampleRate("SENTRY_TRACES_SAMPLE_RATE");
parseSampleRate("NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE");
parseSampleRate("VITE_SENTRY_TRACES_SAMPLE_RATE");

if (appUrl?.protocol === "https:" && livekitUrl?.protocol !== "wss:") {
  issues.push(
    "LIVEKIT_URL must use wss:// when NEXT_PUBLIC_APP_URL uses https://",
  );
}

for (const [key, url] of [
  ["VITE_SHAPE_API_URL", desktopApiUrl],
  ["VITE_SHAPE_APP_URL", desktopAppUrl],
  ["VITE_SHAPE_MEETING_URL", meetingUrl],
]) {
  if (appUrl?.protocol === "https:" && url?.protocol !== "https:") {
    issues.push(
      `${key} must use https:// when NEXT_PUBLIC_APP_URL uses https://`,
    );
  }
}

validateCorsOrigins(corsOrigins, [
  ["NEXT_PUBLIC_APP_URL", appUrl],
  ["VITE_SHAPE_MEETING_URL", meetingUrl],
]);
validateDesktopCorsOrigins(corsOrigins);

if (livekitUrl?.hostname && livekitUrl.hostname === turnDomain) {
  issues.push(
    "LIVEKIT_URL host and LIVEKIT_TURN_DOMAIN must be separate domains",
  );
}

if (appUrl?.hostname && appUrl.hostname === turnDomain) {
  issues.push(
    "NEXT_PUBLIC_APP_URL host and LIVEKIT_TURN_DOMAIN must be separate domains",
  );
}

validateHostOnly("LIVEKIT_TURN_DOMAIN", turnDomain);
validateExternalIp("LIVEKIT_TURN_EXTERNAL_IP", turnExternalIp);

if (livekitUseExternalIp === false && !livekitNodeIp) {
  issues.push(
    "LIVEKIT_NODE_IP is required when LIVEKIT_USE_EXTERNAL_IP=false so LiveKit does not announce an internal container IP",
  );
}

if (
  livekitUseExternalIp === true &&
  livekitNodeIp &&
  !isPlaceholder(livekitNodeIp)
) {
  warnings.push(
    "LIVEKIT_NODE_IP is set but LIVEKIT_USE_EXTERNAL_IP=true; confirm this is intentional for the Coolify node",
  );
}

const servicePorts = [
  ["ADMIN_HTTP_PORT", adminHttpPort],
  ["LIVEKIT_HTTP_PORT", livekitHttpPort],
  ["LIVEKIT_RTC_TCP_PORT", rtcTcpPort],
  ["LIVEKIT_RTC_UDP_PORT", rtcUdpPort],
  ["LIVEKIT_TURN_UDP_PORT", turnUdpPort],
  ["LIVEKIT_TURN_TLS_PORT", turnTlsPort],
].filter(([, value]) => Boolean(value));
const seenPorts = new Map();
for (const [label, port] of servicePorts) {
  const previous = seenPorts.get(port);
  if (previous) {
    issues.push(`${label} collides with ${previous} on port ${port}`);
  } else {
    seenPorts.set(port, label);
  }
}

for (const [label, port] of servicePorts) {
  if (relayStart && relayEnd && port >= relayStart && port <= relayEnd) {
    issues.push(`${label} must not be inside TURN relay port range`);
  }
}

if (relayStart && relayEnd && relayEnd < relayStart) {
  issues.push(
    "LIVEKIT_TURN_RELAY_RANGE_END must be greater than or equal to START",
  );
}

if (relayStart && relayEnd && relayEnd - relayStart < 100) {
  warnings.push(
    "TURN relay range is narrow; keep at least 100 UDP ports for multi-participant tests",
  );
}

if (relayStart && relayStart < 1024) {
  warnings.push(
    "TURN relay range starts below 1024; prefer high UDP ports to avoid privileged binding and platform restrictions",
  );
}

if (turnExternalIp && isLocalAddress(turnExternalIp)) {
  const message =
    "LIVEKIT_TURN_EXTERNAL_IP points to a local/private address; production TURN needs the public server IP";
  if (strict) issues.push(message);
  else warnings.push(message);
}

if (turnTlsPort && turnTlsPort !== 443) {
  warnings.push(
    "TURN/TLS on a port other than 443 may fail behind strict corporate firewalls; use an L4/SNI route for 443 when available",
  );
}

if (turnTtlSeconds && turnTtlSeconds < 300) {
  warnings.push(
    "LIVEKIT_TURN_TTL_SECONDS is short; 300 seconds or more avoids credential churn during connection setup",
  );
}

const compose = spawnSync(
  "docker",
  ["compose", "--env-file", envFile, "-f", composeFile, "config"],
  { encoding: "utf8" },
);

if (compose.error?.code === "ENOENT") {
  warnings.push(
    "docker compose not found; skipped rendered compose validation",
  );
} else if (compose.status !== 0) {
  issues.push(
    `docker compose config failed:\n${compose.stderr || compose.stdout}`,
  );
} else {
  const rendered = compose.stdout;
  for (const expected of [
    "shape-admin",
    "shape-livekit",
    "shape-postgres",
    "shape-redis",
    "shape-turn",
  ]) {
    if (!rendered.includes(expected))
      issues.push(`rendered compose is missing ${expected}`);
  }
  if (!rendered.includes("turn_servers:")) {
    issues.push(
      "rendered LiveKit config does not include external TURN servers",
    );
  }
  if (!rendered.includes("enabled: false")) {
    issues.push(
      "rendered LiveKit config should disable embedded TURN when shape-turn is present",
    );
  }
  if (
    !rendered.includes("--use-auth-secret") ||
    !rendered.includes("--static-auth-secret")
  ) {
    issues.push(
      "rendered coturn command is missing shared-secret authentication",
    );
  }
  if (!rendered.includes("turnutils_uclient")) {
    issues.push("rendered coturn service is missing TURN healthcheck");
  }
  if (!rendered.includes("SHAPE_DEBUG_ERRORS:")) {
    issues.push("rendered admin environment is missing SHAPE_DEBUG_ERRORS");
  }
  for (const expected of [
    "SENTRY_DSN:",
    "NEXT_PUBLIC_SENTRY_DSN:",
    "SENTRY_ENVIRONMENT:",
    "NEXT_PUBLIC_SENTRY_ENVIRONMENT:",
    "SENTRY_RELEASE:",
    "NEXT_PUBLIC_SENTRY_RELEASE:",
    "SENTRY_TRACES_SAMPLE_RATE:",
    "NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE:",
    "SENTRY_DEBUG:",
    "NEXT_PUBLIC_SENTRY_DEBUG:",
  ]) {
    if (!rendered.includes(expected)) {
      issues.push(
        `rendered admin environment is missing ${expected.slice(0, -1)}`,
      );
    }
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

function parseCorsOrigins(key) {
  const value = env[key];
  if (!value) return [];
  const origins = value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (origins.includes("*")) return ["*"];

  return origins.map((origin) => {
    if (DESKTOP_CORS_ORIGINS.includes(origin)) return origin;

    try {
      const parsed = new URL(origin);
      if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
        issues.push(
          `${key} origin must not include path, query or fragment: ${origin}`,
        );
      }
      return parsed.origin;
    } catch {
      issues.push(`${key} contains an invalid origin: ${origin}`);
      return origin;
    }
  });
}

function validateCorsOrigins(origins, requiredUrls) {
  if (origins.includes("*")) {
    warnings.push(
      "CORS_ORIGIN=* permite cualquier origen; para producción prefiere NEXT_PUBLIC_APP_URL,VITE_SHAPE_MEETING_URL y orígenes Tauri",
    );
    return;
  }

  for (const [key, url] of requiredUrls) {
    if (!url) continue;
    if (!origins.includes(url.origin)) {
      issues.push(
        `CORS_ORIGIN must include ${url.origin} so ${key} can call the admin API`,
      );
    }
  }
}

function validateDesktopCorsOrigins(origins) {
  if (origins.includes("*")) return;

  for (const origin of DESKTOP_CORS_ORIGINS) {
    if (!origins.includes(origin)) {
      issues.push(
        `CORS_ORIGIN must include ${origin} so the packaged Tauri desktop can call the admin API`,
      );
    }
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

function parsePositiveInteger(key) {
  if (!env[key]) return null;
  const value = Number(env[key]);
  if (!Number.isInteger(value) || value < 1) {
    issues.push(`${key} must be a positive integer`);
    return null;
  }
  return value;
}

function parseBoolean(key) {
  if (!env[key]) return null;
  if (!["true", "false"].includes(env[key].toLowerCase())) {
    issues.push(`${key} must be true or false`);
  }
  return env[key].toLowerCase() === "true";
}

function parseOptionalBoolean(key) {
  if (!env[key]) return null;
  return parseBoolean(key);
}

function parseSampleRate(key) {
  if (!env[key]) return null;
  const value = Number(env[key]);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    issues.push(`${key} must be a number between 0 and 1`);
    return null;
  }
  return value;
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
    /^shape-turn-local-secret$/i,
    /^shape-turn-dev-secret$/i,
    /^local-debug/i,
  ].some((pattern) => pattern.test(value));
}

function validateHostOnly(key, value) {
  if (!value || isPlaceholder(value)) return;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    issues.push(`${key} must be a host name only, without protocol`);
    return;
  }
  if (value.includes("/") || value.includes("?") || value.includes("#")) {
    issues.push(`${key} must not include path, query or fragment`);
  }
  if (value.includes(":")) {
    issues.push(`${key} must not include a port; use LIVEKIT_TURN_*_PORT`);
  }
}

function validateExternalIp(key, value) {
  if (!value || isPlaceholder(value)) return;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    issues.push(
      `${key} must be an IP address or public/private IP pair, not a URL`,
    );
    return;
  }
  if (value.includes(":")) {
    issues.push(`${key} must not include a port`);
  }
  const [publicIp, privateIp] = value.split("/");
  for (const [label, ip] of [
    ["public", publicIp],
    ["private", privateIp],
  ]) {
    if (ip && !isIpv4(ip)) {
      issues.push(`${key} ${label} value is not an IPv4 address: ${ip}`);
    }
  }
}

function isLocalAddress(value) {
  const first = value.split("/")[0] ?? value;
  return [
    /^127\./,
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[0-1])\./,
    /^localhost$/i,
  ].some((pattern) => pattern.test(first));
}

function isIpv4(value) {
  const parts = String(value).split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => {
      if (!/^\d{1,3}$/.test(part)) return false;
      const value = Number(part);
      return value >= 0 && value <= 255;
    })
  );
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
