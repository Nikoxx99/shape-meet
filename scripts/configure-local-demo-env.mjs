import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const root = resolve(argValue("--root") ?? process.cwd());
const dryRun = args.includes("--dry-run");

const config = {
  apiUrl: trimTrailingSlash(argValue("--api-url") ?? "http://localhost:13000"),
  appUrl: trimTrailingSlash(argValue("--app-url") ?? "http://localhost:1420"),
  aiUrl: trimTrailingSlash(argValue("--ai-url") ?? "http://127.0.0.1:7851"),
  liveKitUrl: trimTrailingSlash(
    argValue("--livekit-url") ?? "ws://localhost:17880",
  ),
  hostEmail: argValue("--host") ?? "admin@shape.test",
  hostPassword: argValue("--password") ?? "ChangeMe123!",
  postgresUser: argValue("--postgres-user") ?? "shape_meet",
  postgresPassword: argValue("--postgres-password") ?? "shape_meet",
  postgresDb: argValue("--postgres-db") ?? "shape_meet",
  localPostgresPort: argValue("--postgres-port") ?? "55433",
  adminPort: argValue("--admin-port") ?? "13000",
  liveKitApiKey: argValue("--livekit-api-key") ?? "devkey",
  liveKitApiSecret: argValue("--livekit-api-secret") ?? "secret",
};

validateConfig();

const databaseUrl = `postgresql://${config.postgresUser}:${config.postgresPassword}@localhost:${config.localPostgresPort}/${config.postgresDb}?schema=public`;
const files = [
  {
    label: "root demo",
    file: ".env.local",
    entries: {
      POSTGRES_USER: config.postgresUser,
      POSTGRES_PASSWORD: config.postgresPassword,
      POSTGRES_DB: config.postgresDb,
      REDIS_PASSWORD: "shape_redis",
      AUTH_SESSION_SECRET: "local-debug-secret-please-change",
      CORS_ORIGIN: "*",
      RUN_SEED: "true",
      SHAPE_DEBUG_ERRORS: "true",
      HOST_BOOTSTRAP_EMAIL: config.hostEmail,
      HOST_BOOTSTRAP_PASSWORD: config.hostPassword,
      ADMIN_HTTP_PORT: config.adminPort,
      NEXT_PUBLIC_APP_URL: config.apiUrl,
      LIVEKIT_URL: config.liveKitUrl,
      SHAPE_DEMO_LIVEKIT_URL: config.liveKitUrl,
      LIVEKIT_API_KEY: config.liveKitApiKey,
      LIVEKIT_API_SECRET: config.liveKitApiSecret,
      LIVEKIT_HTTP_PORT: "17883",
      LIVEKIT_USE_EXTERNAL_IP: "false",
      LIVEKIT_NODE_IP: "127.0.0.1",
      LIVEKIT_ENABLE_LOOPBACK_CANDIDATE: "true",
      LIVEKIT_RTC_TCP_PORT: "17884",
      LIVEKIT_RTC_UDP_PORT: "17885",
      LIVEKIT_TURN_DOMAIN: "127.0.0.1",
      LIVEKIT_TURN_REALM: "shape-meet-local",
      LIVEKIT_TURN_SHARED_SECRET: "shape-turn-local-secret",
      LIVEKIT_TURN_TTL_SECONDS: "14400",
      LIVEKIT_TURN_EXTERNAL_IP: "127.0.0.1",
      LIVEKIT_STUN_SERVER: "stun.l.google.com:19302",
      LIVEKIT_TURN_UDP_PORT: "13478",
      LIVEKIT_TURN_TLS_PORT: "15349",
      LIVEKIT_TURN_RELAY_RANGE_START: "30000",
      LIVEKIT_TURN_RELAY_RANGE_END: "30100",
      VITE_SHAPE_API_URL: config.apiUrl,
      VITE_SHAPE_APP_URL: config.appUrl,
      VITE_SHAPE_MEETING_URL: config.appUrl,
      VITE_SHAPE_AI_SERVICE_URL: config.aiUrl,
      VITE_SHAPE_HOST_IDENTIFIER: config.hostEmail,
      VITE_SHAPE_DEMO_DATA: "false",
      SHAPE_AI_SERVICE_URL: config.aiUrl,
      SHAPE_ARTIFACT_STORAGE_DIR: "/app/artifacts",
      SHAPE_ARTIFACT_MAX_BYTES: "2147483648",
    },
  },
  {
    label: "admin dev",
    file: join("apps", "admin", ".env.local"),
    entries: {
      DATABASE_URL: databaseUrl,
      NEXT_PUBLIC_APP_URL: config.apiUrl,
      CORS_ORIGIN: "*",
      RUN_SEED: "true",
      SHAPE_DEBUG_ERRORS: "true",
      AUTH_SESSION_SECRET: "local-debug-secret-please-change",
      HOST_BOOTSTRAP_EMAIL: config.hostEmail,
      HOST_BOOTSTRAP_PASSWORD: config.hostPassword,
      LIVEKIT_URL: config.liveKitUrl,
      LIVEKIT_API_KEY: config.liveKitApiKey,
      LIVEKIT_API_SECRET: config.liveKitApiSecret,
      SHAPE_ARTIFACT_STORAGE_DIR: "apps/admin/shape-artifacts",
      SHAPE_ARTIFACT_MAX_BYTES: "2147483648",
    },
  },
  {
    label: "desktop dev",
    file: join("apps", "desktop", ".env.local"),
    entries: {
      VITE_SHAPE_API_URL: config.apiUrl,
      VITE_SHAPE_APP_URL: config.appUrl,
      VITE_SHAPE_MEETING_URL: config.appUrl,
      VITE_SHAPE_AI_SERVICE_URL: config.aiUrl,
      VITE_SHAPE_HOST_IDENTIFIER: config.hostEmail,
      VITE_SHAPE_DEMO_DATA: "false",
    },
  },
];

for (const item of files) {
  const result = updateEnvFile(resolve(root, item.file), item.entries);
  console.log(
    `${dryRun ? "would update" : "updated"} ${item.label}: ${item.file} (${result.updated} updated, ${result.added} added)`,
  );
}

console.log(`Admin/API: ${config.apiUrl}`);
console.log(`Desktop: ${config.appUrl}`);
console.log(`LiveKit: ${config.liveKitUrl}`);
console.log(`IA local: ${config.aiUrl}`);
console.log("Next: pnpm demo:up -- --replace-ai");

function updateEnvFile(filePath, entries) {
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const lines = existing ? existing.split(/\r?\n/) : [];
  if (lines.length > 0 && lines.at(-1) === "") lines.pop();

  const remaining = new Map(Object.entries(entries));
  let updated = 0;
  const nextLines = lines.map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) return line;

    const key = match[1];
    if (!remaining.has(key)) return line;

    updated += 1;
    const value = remaining.get(key);
    remaining.delete(key);
    return `${key}=${quoteEnv(value)}`;
  });

  const additions = [...remaining.entries()].map(
    ([key, value]) => `${key}=${quoteEnv(value)}`,
  );

  if (additions.length > 0) {
    if (nextLines.length > 0 && nextLines.at(-1) !== "") nextLines.push("");
    nextLines.push("# Shape Meet local demo config", ...additions);
  }

  if (!dryRun) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${nextLines.join("\n")}\n`);
  }

  return { updated, added: additions.length };
}

function validateConfig() {
  validateHttpUrl("api-url", config.apiUrl, ["http:", "https:"]);
  validateHttpUrl("app-url", config.appUrl, ["http:", "https:"]);
  validateHttpUrl("ai-url", config.aiUrl, ["http:", "https:"]);
  validateHttpUrl("livekit-url", config.liveKitUrl, ["ws:", "wss:"]);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.hostEmail)) {
    fail("--host must be an email.");
  }

  for (const [label, value] of [
    ["postgres-port", config.localPostgresPort],
    ["admin-port", config.adminPort],
  ]) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
      fail(`--${label} must be a valid TCP port.`);
    }
  }
}

function validateHttpUrl(label, value, protocols) {
  try {
    const url = new URL(value);
    if (!protocols.includes(url.protocol)) throw new Error("bad protocol");
  } catch {
    fail(`--${label} must be a valid ${protocols.join("/")} URL.`);
  }
}

function argValue(name) {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/$/, "");
}

function quoteEnv(value) {
  if (value === undefined || value === null || value === "") return "";
  const normalized = String(value);
  if (/^[A-Za-z0-9_./:@*-]+$/.test(normalized)) return normalized;
  return JSON.stringify(normalized);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
