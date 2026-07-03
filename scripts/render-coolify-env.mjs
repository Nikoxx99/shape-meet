import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const adminDomain = requiredArg("--admin-domain");
const livekitDomain = requiredArg("--livekit-domain");
const turnDomain = requiredArg("--turn-domain");
const publicIp = requiredArg("--public-ip");
const meetingDomain = argValue("--meeting-domain") ?? adminDomain;
const bootstrapEmail =
  argValue("--bootstrap-email") ?? `admin@${baseDomain(adminDomain)}`;
const sentryDsn = argValue("--sentry-dsn") ?? "";
const sentryOrg = argValue("--sentry-org") ?? "";
const sentryProject = argValue("--sentry-project") ?? "";
const sentryAuthToken = argValue("--sentry-auth-token") ?? "";
const turnTlsPort = argValue("--turn-tls-port") ?? "5349";
const relayStart = argValue("--relay-start") ?? "30000";
const relayEnd = argValue("--relay-end") ?? "30100";
const releaseSuffix = argValue("--release") ?? "0.1.0";
const runSeed = argValue("--run-seed") ?? "true";
const debugErrors = argValue("--debug-errors") ?? "true";
const outputPath = argValue("--out");

validateDomain("admin-domain", adminDomain);
validateDomain("meeting-domain", meetingDomain);
validateDomain("livekit-domain", livekitDomain);
validateDomain("turn-domain", turnDomain);
validatePublicIp(publicIp);
validateBoolean("run-seed", runSeed);
validateBoolean("debug-errors", debugErrors);

const adminUrl = `https://${adminDomain}`;
const meetingUrl = `https://${meetingDomain}`;
const livekitUrl = `wss://${livekitDomain}`;
const bootstrapPassword = `${randomHex(12)}Aa1!`;
const env = [
  ["POSTGRES_USER", "shape_meet"],
  ["POSTGRES_PASSWORD", randomHex(24)],
  ["POSTGRES_DB", "shape_meet"],
  ["REDIS_PASSWORD", randomHex(24)],
  ["AUTH_SESSION_SECRET", randomHex(32)],
  ["CORS_ORIGIN", adminUrl],
  ["RUN_SEED", runSeed],
  ["SHAPE_DEBUG_ERRORS", debugErrors],
  ["HOST_BOOTSTRAP_EMAIL", bootstrapEmail],
  ["HOST_BOOTSTRAP_PASSWORD", bootstrapPassword],
  ["LIVEKIT_URL", livekitUrl],
  ["LIVEKIT_API_KEY", randomToken("lk")],
  ["LIVEKIT_API_SECRET", randomHex(32)],
  ["LIVEKIT_HTTP_PORT", "7880"],
  ["LIVEKIT_TURN_DOMAIN", turnDomain],
  ["LIVEKIT_TURN_REALM", "shape-meet"],
  ["LIVEKIT_TURN_SHARED_SECRET", randomHex(32)],
  ["LIVEKIT_TURN_TTL_SECONDS", "14400"],
  ["LIVEKIT_TURN_EXTERNAL_IP", publicIp],
  ["LIVEKIT_STUN_SERVER", "stun.l.google.com:19302"],
  ["LIVEKIT_USE_EXTERNAL_IP", "true"],
  ["LIVEKIT_RTC_TCP_PORT", "7881"],
  ["LIVEKIT_RTC_UDP_PORT", "7882"],
  ["LIVEKIT_TURN_UDP_PORT", "3478"],
  ["LIVEKIT_TURN_TLS_PORT", turnTlsPort],
  ["LIVEKIT_TURN_RELAY_RANGE_START", relayStart],
  ["LIVEKIT_TURN_RELAY_RANGE_END", relayEnd],
  ["NEXT_PUBLIC_APP_URL", adminUrl],
  ["ADMIN_HTTP_PORT", "3000"],
  ["VITE_SHAPE_API_URL", adminUrl],
  ["VITE_SHAPE_APP_URL", meetingUrl],
  ["VITE_SHAPE_MEETING_URL", meetingUrl],
  ["VITE_SHAPE_DEMO_DATA", "false"],
  ["VITE_SHAPE_HOST_IDENTIFIER", bootstrapEmail],
  ["SHAPE_ARTIFACT_STORAGE_DIR", "/app/artifacts"],
  ["SHAPE_ARTIFACT_MAX_BYTES", "2147483648"],
  ["SHAPE_AI_MODE", "development-passthrough"],
  ["SHAPE_FACE_ENGINE", ""],
  ["SHAPE_BACKGROUND_ENGINE", ""],
  ["SHAPE_VOICE_ENGINE", ""],
  ["SHAPE_VIDEO_PROCESSOR_ENDPOINT", ""],
  ["SHAPE_AUDIO_PROCESSOR_ENDPOINT", ""],
  ["SHAPE_PROCESSOR_TIMEOUT_SECS", "0.8"],
  ["SENTRY_DSN", sentryDsn],
  ["SENTRY_ORG", sentryOrg],
  ["SENTRY_PROJECT", sentryProject],
  ["SENTRY_AUTH_TOKEN", sentryAuthToken],
  ["VITE_SENTRY_DSN", sentryDsn],
  ["NEXT_PUBLIC_SENTRY_DSN", sentryDsn],
  ["SENTRY_ENVIRONMENT", "production"],
  ["NEXT_PUBLIC_SENTRY_ENVIRONMENT", "production"],
  ["SENTRY_RELEASE", `shape-meet-admin@${releaseSuffix}`],
  ["NEXT_PUBLIC_SENTRY_RELEASE", `shape-meet-admin@${releaseSuffix}`],
  ["SENTRY_TRACES_SAMPLE_RATE", "1.0"],
  ["NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE", "1.0"],
  ["SENTRY_DEBUG", "false"],
  ["NEXT_PUBLIC_SENTRY_DEBUG", "false"],
  ["VITE_SENTRY_ENVIRONMENT", "production"],
  ["VITE_SENTRY_RELEASE", `shape-meet-desktop@${releaseSuffix}`],
  ["VITE_SENTRY_TRACES_SAMPLE_RATE", "1.0"],
  ["VITE_SENTRY_DEBUG", "false"],
];

const content = `${env.map(([key, value]) => `${key}=${quoteEnv(value)}`).join("\n")}\n`;

if (outputPath) {
  const absolutePath = resolve(outputPath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, { flag: "wx" });
  console.log(`Coolify env written: ${absolutePath}`);
  console.log(`Bootstrap host: ${bootstrapEmail}`);
  console.log(`Bootstrap password: ${bootstrapPassword}`);
  console.log("Run: pnpm check:coolify <path> --strict");
} else {
  process.stdout.write(content);
  process.stderr.write(`\nBootstrap host: ${bootstrapEmail}\n`);
  process.stderr.write(`Bootstrap password: ${bootstrapPassword}\n`);
}

function argValue(name) {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

function requiredArg(name) {
  const value = argValue(name);
  if (!value) {
    console.error(`Missing required argument: ${name}`);
    process.exit(1);
  }
  return value;
}

function validateDomain(label, value) {
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value) || value.includes("..")) {
    console.error(
      `${label} must be a bare domain, for example admin.example.com`,
    );
    process.exit(1);
  }
}

function validatePublicIp(value) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    console.error("--public-ip must be an IPv4 address");
    process.exit(1);
  }

  const octets = value.split(".").map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) {
    console.error("--public-ip contains an invalid IPv4 octet");
    process.exit(1);
  }
}

function validateBoolean(label, value) {
  if (!["true", "false"].includes(String(value).toLowerCase())) {
    console.error(`--${label} must be true or false`);
    process.exit(1);
  }
}

function baseDomain(value) {
  return value.split(".").slice(-2).join(".");
}

function randomHex(bytes) {
  return randomBytes(bytes).toString("hex");
}

function randomToken(prefix) {
  return `${prefix}_${randomBytes(18).toString("base64url")}`;
}

function quoteEnv(value) {
  if (value === "") return "";
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}
