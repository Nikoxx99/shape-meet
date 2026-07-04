import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const printOnly = args.includes("--print");
const dryRun = args.includes("--dry-run");
const install = args.includes("--install");
const envFile = argValue("--env-file");
const env = envFile ? parseEnvFile(resolve(envFile)) : {};
const outputPath =
  argValue("--out") ??
  process.env.SHAPE_DESKTOP_CONFIG_FILE ??
  (install ? defaultDesktopConfigPath() : resolve("output", "shape-meet.env"));

const config = {
  apiUrl: trimTrailingSlash(
    argValue("--api-url") ??
      urlFromDomainArg("--admin-domain") ??
      env.VITE_SHAPE_API_URL ??
      env.SHAPE_API_URL ??
      env.NEXT_PUBLIC_APP_URL ??
      "http://localhost:13000",
  ),
  appUrl: trimTrailingSlash(
    argValue("--app-url") ??
      argValue("--meeting-url") ??
      urlFromDomainArg("--meeting-domain") ??
      env.VITE_SHAPE_APP_URL ??
      env.SHAPE_APP_URL ??
      env.VITE_SHAPE_MEETING_URL ??
      env.SHAPE_MEETING_URL ??
      "http://localhost:1420",
  ),
  meetingUrl: trimTrailingSlash(
    argValue("--meeting-url") ??
      urlFromDomainArg("--meeting-domain") ??
      env.VITE_SHAPE_MEETING_URL ??
      env.SHAPE_MEETING_URL ??
      env.VITE_SHAPE_APP_URL ??
      env.SHAPE_APP_URL ??
      "http://localhost:1420",
  ),
  aiUrl: trimTrailingSlash(
    argValue("--ai-url") ??
      env.VITE_SHAPE_AI_SERVICE_URL ??
      env.SHAPE_AI_SERVICE_URL ??
      "http://127.0.0.1:7851",
  ),
  hostIdentifier:
    argValue("--host-identifier") ??
    env.VITE_SHAPE_HOST_IDENTIFIER ??
    env.SHAPE_HOST_IDENTIFIER ??
    env.HOST_BOOTSTRAP_EMAIL ??
    "",
  sentryDsn:
    argValue("--sentry-dsn") ??
    env.VITE_SENTRY_DSN ??
    env.SENTRY_DSN ??
    env.NEXT_PUBLIC_SENTRY_DSN ??
    "",
  sentryEnvironment:
    argValue("--sentry-environment") ??
    env.VITE_SENTRY_ENVIRONMENT ??
    env.SENTRY_ENVIRONMENT ??
    "internal-debug",
  sentryRelease:
    argValue("--release") ??
    env.VITE_SENTRY_RELEASE ??
    env.SENTRY_RELEASE ??
    "shape-meet-desktop@0.1.0",
  sentryTracesSampleRate:
    argValue("--sentry-traces-sample-rate") ??
    env.VITE_SENTRY_TRACES_SAMPLE_RATE ??
    env.SENTRY_TRACES_SAMPLE_RATE ??
    "1.0",
  sentryDebug:
    argValue("--sentry-debug") ??
    env.VITE_SENTRY_DEBUG ??
    env.SENTRY_DEBUG ??
    "false",
};

validateConfig(config);

const content = renderDesktopConfig(config);

if (printOnly || dryRun) {
  process.stdout.write(content);
}

if (!printOnly && !dryRun) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, content);
  console.log(`Desktop runtime config written: ${outputPath}`);
  console.log(`API: ${config.apiUrl}`);
  console.log(`Meeting: ${config.meetingUrl}`);
  console.log(`AI local: ${config.aiUrl}`);
}

function renderDesktopConfig(input) {
  const entries = [
    ["SHAPE_API_URL", input.apiUrl],
    ["VITE_SHAPE_API_URL", input.apiUrl],
    ["SHAPE_APP_URL", input.appUrl],
    ["VITE_SHAPE_APP_URL", input.appUrl],
    ["SHAPE_MEETING_URL", input.meetingUrl],
    ["VITE_SHAPE_MEETING_URL", input.meetingUrl],
    ["SHAPE_AI_SERVICE_URL", input.aiUrl],
    ["VITE_SHAPE_AI_SERVICE_URL", input.aiUrl],
    ["SHAPE_DEMO_DATA", "false"],
    ["VITE_SHAPE_DEMO_DATA", "false"],
    ["SHAPE_HOST_IDENTIFIER", input.hostIdentifier],
    ["VITE_SHAPE_HOST_IDENTIFIER", input.hostIdentifier],
    ["SENTRY_DSN", input.sentryDsn],
    ["VITE_SENTRY_DSN", input.sentryDsn],
    ["SENTRY_ENVIRONMENT", input.sentryEnvironment],
    ["VITE_SENTRY_ENVIRONMENT", input.sentryEnvironment],
    ["SENTRY_RELEASE", input.sentryRelease],
    ["VITE_SENTRY_RELEASE", input.sentryRelease],
    ["SENTRY_TRACES_SAMPLE_RATE", input.sentryTracesSampleRate],
    ["VITE_SENTRY_TRACES_SAMPLE_RATE", input.sentryTracesSampleRate],
    ["SENTRY_DEBUG", input.sentryDebug],
    ["VITE_SENTRY_DEBUG", input.sentryDebug],
  ];

  return `${[
    "# Shape Meet desktop runtime config",
    "# Copy to the app data directory as shape-meet.env, or set SHAPE_DESKTOP_CONFIG_FILE.",
    ...entries.map(([key, value]) => `${key}=${quoteEnv(value)}`),
    "",
  ].join("\n")}`;
}

function validateConfig(input) {
  for (const [label, value] of [
    ["api-url", input.apiUrl],
    ["app-url", input.appUrl],
    ["meeting-url", input.meetingUrl],
    ["ai-url", input.aiUrl],
  ]) {
    validateHttpUrl(label, value);
  }

  if (
    input.hostIdentifier &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.hostIdentifier)
  ) {
    fail("--host-identifier must be an email when provided");
  }

  const tracesSampleRate = Number(input.sentryTracesSampleRate);
  if (
    !Number.isFinite(tracesSampleRate) ||
    tracesSampleRate < 0 ||
    tracesSampleRate > 1
  ) {
    fail("--sentry-traces-sample-rate must be a number between 0 and 1");
  }

  if (!["true", "false"].includes(String(input.sentryDebug).toLowerCase())) {
    fail("--sentry-debug must be true or false");
  }

  if (input.sentryDsn) {
    validateHttpUrl("sentry-dsn", input.sentryDsn);
  }
}

function parseEnvFile(file) {
  if (!existsSync(file)) fail(`env file not found: ${file}`);

  const values = {};
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;
    const key = line.slice(0, equalsIndex).trim();
    values[key] = unquoteEnv(line.slice(equalsIndex + 1).trim());
  }
  return values;
}

function argValue(name) {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

function urlFromDomainArg(name) {
  const domain = argValue(name);
  return domain ? `https://${domain}` : null;
}

function defaultDesktopConfigPath() {
  if (process.platform === "win32") {
    return join(
      process.env.LOCALAPPDATA ?? homedir(),
      "Shape Meet",
      "shape-meet.env",
    );
  }
  if (process.platform === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "Shape Meet",
      "shape-meet.env",
    );
  }
  return join(
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
    "shape-meet",
    "shape-meet.env",
  );
}

function validateHttpUrl(label, value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("invalid protocol");
    }
  } catch {
    fail(`--${label} must be a valid http(s) URL`);
  }
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/$/, "");
}

function unquoteEnv(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function quoteEnv(value) {
  if (!value) return "";
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
