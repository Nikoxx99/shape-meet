import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const root = resolve(argValue("--root") ?? process.cwd());
const dryRun = args.includes("--dry-run");
const verifyLive =
  args.includes("--verify-live") ||
  args.includes("--live") ||
  args.includes("--send-test-event");
const allowInvalidLive = args.includes("--allow-invalid-live");
const dsn =
  argValue("--dsn") ??
  process.env.SENTRY_DSN ??
  process.env.VITE_SENTRY_DSN ??
  process.env.NEXT_PUBLIC_SENTRY_DSN ??
  "";
const environment = argValue("--environment") ?? "internal-debug";
const tracesSampleRate = argValue("--traces-sample-rate") ?? "1.0";
const debug = argValue("--debug") ?? "true";
const releaseSuffix = argValue("--release-suffix") ?? "0.1.0";

validateInput();

if (verifyLive) {
  const live = await verifyLiveDsn(dsn);
  if (!live.ok) {
    const message = `Sentry live check failed: ${live.message}`;
    if (!allowInvalidLive) {
      fail(
        `${message}\nNo se escribieron cambios. Copia una DSN nueva desde Sentry Project Settings > Client Keys, o usa --allow-invalid-live para forzar.`,
      );
    }
    console.warn(`${message}\nContinuando por --allow-invalid-live.`);
  } else {
    console.log(`Sentry live ok: ${maskDsn(dsn)}`);
  }
}

const files = [
  {
    label: "root/sidecar",
    file: ".env.local",
    entries: commonEntries({
      release: `shape-meet-local@${releaseSuffix}`,
      includeAdminPublic: true,
      includeDesktopPublic: true,
    }),
  },
  {
    label: "admin",
    file: join("apps", "admin", ".env.local"),
    entries: commonEntries({
      release: `shape-meet-admin@${releaseSuffix}`,
      includeAdminPublic: true,
      includeDesktopPublic: false,
    }),
  },
  {
    label: "desktop",
    file: join("apps", "desktop", ".env.local"),
    entries: commonEntries({
      release: `shape-meet-desktop@${releaseSuffix}`,
      includeAdminPublic: false,
      includeDesktopPublic: true,
    }),
  },
];

for (const item of files) {
  const result = updateEnvFile(resolve(root, item.file), item.entries);
  console.log(
    `${dryRun ? "would update" : "updated"} ${item.label}: ${item.file} (${result.updated} updated, ${result.added} added)`,
  );
}

console.log(`Sentry DSN: ${maskDsn(dsn)}`);
console.log(`Environment: ${environment}`);
console.log(
  verifyLive
    ? "Next: pnpm check:sentry:live"
    : "Next: pnpm check:sentry && pnpm check:sentry:live",
);

function commonEntries({ release, includeAdminPublic, includeDesktopPublic }) {
  const entries = {
    SENTRY_DSN: dsn,
    SENTRY_ENVIRONMENT: environment,
    SENTRY_RELEASE: release,
    SENTRY_TRACES_SAMPLE_RATE: tracesSampleRate,
    SENTRY_DEBUG: debug,
  };

  if (includeAdminPublic) {
    entries.NEXT_PUBLIC_SENTRY_DSN = dsn;
    entries.NEXT_PUBLIC_SENTRY_ENVIRONMENT = environment;
    entries.NEXT_PUBLIC_SENTRY_RELEASE = `shape-meet-admin@${releaseSuffix}`;
    entries.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE = tracesSampleRate;
    entries.NEXT_PUBLIC_SENTRY_DEBUG = debug;
  }

  if (includeDesktopPublic) {
    entries.VITE_SENTRY_DSN = dsn;
    entries.VITE_SENTRY_ENVIRONMENT = environment;
    entries.VITE_SENTRY_RELEASE = `shape-meet-desktop@${releaseSuffix}`;
    entries.VITE_SENTRY_TRACES_SAMPLE_RATE = tracesSampleRate;
    entries.VITE_SENTRY_DEBUG = debug;
  }

  return entries;
}

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
    nextLines.push("# Shape Meet Sentry local demo config", ...additions);
  }

  if (!dryRun) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${nextLines.join("\n")}\n`);
  }

  return { updated, added: additions.length };
}

function validateInput() {
  if (!dsn) fail("Missing --dsn or SENTRY_DSN.");

  let url;
  try {
    url = new URL(dsn);
  } catch {
    fail("--dsn must be a valid Sentry DSN URL.");
  }

  if (
    url.protocol !== "https:" ||
    !url.username ||
    !/^\/\d+\/?$/.test(url.pathname)
  ) {
    fail("--dsn must look like https://public_key@o123.ingest.sentry.io/456.");
  }

  const parsedSampleRate = Number(tracesSampleRate);
  if (
    !Number.isFinite(parsedSampleRate) ||
    parsedSampleRate < 0 ||
    parsedSampleRate > 1
  ) {
    fail("--traces-sample-rate must be a number between 0 and 1.");
  }

  if (!["true", "false"].includes(String(debug).toLowerCase())) {
    fail("--debug must be true or false.");
  }
}

async function verifyLiveDsn(value) {
  const parsed = parseDsn(value);
  if (!parsed) {
    return { ok: false, message: "DSN inválida." };
  }

  const fixtureStatus = process.env.SHAPE_SENTRY_CONFIGURE_LIVE_STATUS;
  if (fixtureStatus) {
    const status = Number(fixtureStatus);
    const body = process.env.SHAPE_SENTRY_CONFIGURE_LIVE_BODY ?? "";
    return {
      ok: status >= 200 && status < 300,
      message:
        status >= 200 && status < 300
          ? "ok"
          : sentryHttpErrorMessage(status, body),
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const endpoint = `${parsed.protocol}//${parsed.host}/api/${parsed.projectId}/envelope/?sentry_key=${encodeURIComponent(
    parsed.publicKey,
  )}&sentry_version=7&sentry_client=shape-meet-configure/0.1`;
  const eventId = randomUUID().replaceAll("-", "");
  const envelope = sentryEnvelope(parsed, {
    event_id: eventId,
    timestamp: new Date().toISOString(),
    platform: "javascript",
    logger: "shape-meet.configure-sentry",
    level: "info",
    message: "Shape Meet Sentry configure live check",
    environment,
    release: `shape-meet-configure@${releaseSuffix}`,
    tags: {
      "app.surface": "sentry-configure",
      "shape.check": "configure-live",
    },
  });

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-sentry-envelope" },
      body: envelope,
      signal: controller.signal,
    });
    const text = await response.text();
    return {
      ok: response.ok,
      message: response.ok
        ? "ok"
        : sentryHttpErrorMessage(response.status, text),
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function sentryEnvelope(dsn, event) {
  return `${[
    JSON.stringify({
      event_id: event.event_id,
      sent_at: new Date().toISOString(),
      dsn: `${dsn.protocol}//${dsn.publicKey}@${dsn.host}/${dsn.projectId}`,
    }),
    JSON.stringify({ type: "event" }),
    JSON.stringify(event),
  ].join("\n")}\n`;
}

function parseDsn(value) {
  try {
    const url = new URL(value);
    return {
      protocol: url.protocol,
      host: url.host,
      publicKey: url.username,
      projectId: url.pathname.replace(/^\/+|\/+$/g, ""),
    };
  } catch {
    return null;
  }
}

function sentryHttpErrorMessage(status, text) {
  const detail = String(text ?? "").slice(0, 240);
  const hint = /ProjectId/i.test(detail)
    ? "La clave pública y el project id no pertenecen al mismo proyecto, o el proyecto no acepta ingesta para esa DSN."
    : "";
  return [`HTTP ${status}: ${detail}`, hint].filter(Boolean).join(" ");
}

function argValue(name) {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

function quoteEnv(value) {
  if (value === undefined || value === null || value === "") return "";
  const normalized = String(value);
  if (/^[A-Za-z0-9_./:@-]+$/.test(normalized)) return normalized;
  return JSON.stringify(normalized);
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

function fail(message) {
  console.error(message);
  process.exit(1);
}
