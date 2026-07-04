import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const repoRoot = resolve(import.meta.dirname, "..");
const defaultCoolifyEnv = resolve(
  repoRoot,
  "../pos/.claude/coolify.local.env",
);
const coolifyEnvFile =
  argValue("--coolify-env-file") ??
  process.env.COOLIFY_ENV_FILE ??
  (existsSync(defaultCoolifyEnv) ? defaultCoolifyEnv : null);
const outputDir = resolve(
  argValue("--out") ??
    join("output", "coolify-deploy", safeTimestamp(new Date())),
);
const projectName = argValue("--project-name") ?? "Shape Meet";
const environmentName = argValue("--environment") ?? "production";
const applicationName = argValue("--application-name") ?? "shape-meet-demo";
const repository = argValue("--repository") ?? "Luxora-Agency/shape-meet";
const branch = argValue("--branch") ?? "main";
const composeLocation =
  argValue("--compose-location") ?? "/infra/docker-compose.coolify.yml";
const githubAppOrg = argValue("--github-app-org") ?? "Luxora-Agency";
const sentryDsn = argValue("--sentry-dsn") ?? process.env.SENTRY_DSN ?? "";
const release = argValue("--release") ?? "0.1.0";
const bootstrapEmail =
  argValue("--bootstrap-email") ?? "host@shape-meet.local";
const deploy = !args.includes("--skip-deploy");
const waitForHealth = !args.includes("--no-wait");

if (!coolifyEnvFile || !existsSync(coolifyEnvFile)) {
  fail(
    "No encontre credenciales Coolify. Usa --coolify-env-file o COOLIFY_ENV_FILE.",
  );
}

mkdirSync(outputDir, { recursive: true });

const localEnv = {
  ...process.env,
  ...loadDotenv(coolifyEnvFile),
};
const coolifyBase = normalizeApiBase(requiredEnv(localEnv, "COOLIFY_BASE"));
const coolifyToken = requiredEnv(localEnv, "COOLIFY_TOKEN");
const publicIp = argValue("--public-ip") ?? publicIpFromBase(coolifyBase);

if (!publicIp) {
  fail("Falta --public-ip y no pude derivarlo de COOLIFY_BASE.");
}

const adminDomain =
  argValue("--admin-domain") ?? `shape-meet-admin.${publicIp}.sslip.io`;
const livekitDomain =
  argValue("--livekit-domain") ?? `shape-meet-livekit.${publicIp}.sslip.io`;
const turnDomain =
  argValue("--turn-domain") ?? `shape-meet-turn.${publicIp}.sslip.io`;
const adminUrl = `https://${adminDomain}`;
const livekitUrl = `wss://${livekitDomain}`;

const api = makeApiClient(coolifyBase, coolifyToken);

console.log("Coolify deploy target:");
console.log(`- project: ${projectName}`);
console.log(`- app: ${applicationName}`);
console.log(`- repo: ${repository}#${branch}`);
console.log(`- admin: ${adminUrl}`);
console.log(`- livekit: ${livekitUrl}`);
console.log(`- turn: ${turnDomain}`);

const server = await resolveServer(api);
const githubApp = await resolveGithubApp(api);
const project = await ensureProject(api);
const environment = await ensureEnvironment(api, project.uuid);
const envFile = await renderEnvFile();
const env = parseEnvFile(envFile);
const application = await ensureApplication(api, {
  projectUuid: project.uuid,
  environmentUuid: environment.uuid,
  serverUuid: server.uuid,
  githubAppUuid: githubApp.uuid,
});
await upsertEnvironmentVariables(api, application.uuid, env);
await waitForComposeLoad(api, application.uuid);

if (deploy) {
  await startDeployment(api, application.uuid);
}

const remoteEnvFile = writeRemoteDemoEnv(env);
const manifest = {
  ok: true,
  generatedAt: new Date().toISOString(),
  coolifyBase: redactBase(coolifyBase),
  project: { uuid: project.uuid, name: project.name ?? projectName },
  environment: {
    uuid: environment.uuid,
    name: environment.name ?? environmentName,
  },
  server: { uuid: server.uuid, name: server.name },
  githubApp: { uuid: githubApp.uuid, name: githubApp.name },
  application: { uuid: application.uuid, name: applicationName },
  domains: {
    adminUrl,
    livekitUrl,
    turnDomain,
  },
  files: {
    envFile,
    remoteEnvFile,
    bootstrapPassword: join(outputDir, "bootstrap-password.txt"),
  },
  deployed: deploy,
};

writeFileSync(
  join(outputDir, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

if (deploy && waitForHealth) {
  await waitForAdminHealth(adminUrl);
}

console.log("Coolify deploy prepared:");
console.log(`- application uuid: ${application.uuid}`);
console.log(`- admin health: ${adminUrl}/api/health`);
console.log(`- remote verifier env: ${relativePath(remoteEnvFile)}`);
console.log(`- manifest: ${relativePath(join(outputDir, "manifest.json"))}`);

function argValue(name) {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

function requiredEnv(env, key) {
  const value = env[key];
  if (!value) fail(`Falta ${key} en ${coolifyEnvFile}`);
  return value;
}

function loadDotenv(path) {
  const values = {};
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = rawLine.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if (
      (value.startsWith('"') && !value.endsWith('"')) ||
      (value.startsWith("'") && !value.endsWith("'"))
    ) {
      const quote = value[0];
      const parts = [value.slice(1)];
      while (index + 1 < lines.length) {
        index += 1;
        const next = lines[index];
        if (next.endsWith(quote)) {
          parts.push(next.slice(0, -1));
          break;
        }
        parts.push(next);
      }
      values[key] = parts.join("\n");
      continue;
    }
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

function normalizeApiBase(value) {
  const trimmed = value.replace(/\/$/, "");
  return trimmed.endsWith("/api/v1") ? trimmed : `${trimmed}/api/v1`;
}

function publicIpFromBase(value) {
  try {
    const hostname = new URL(value).hostname;
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) ? hostname : null;
  } catch {
    return null;
  }
}

function makeApiClient(base, token) {
  return async function api(path, options = {}) {
    const response = await fetch(`${base}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers ?? {}),
      },
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!response.ok) {
      const message =
        typeof body === "object" && body?.message
          ? body.message
          : `HTTP ${response.status}`;
      const error = new Error(`${path}: ${message}`);
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  };
}

async function resolveServer(api) {
  const requested = argValue("--server-uuid") ?? argValue("--server-name");
  const servers = await api("/servers");
  if (!Array.isArray(servers) || servers.length === 0) {
    fail("Coolify no tiene servidores disponibles.");
  }
  const server = requested
    ? servers.find(
        (item) => item.uuid === requested || item.name === requested,
      )
    : servers[0];
  if (!server) fail(`No encontre servidor Coolify: ${requested}`);
  return server;
}

async function resolveGithubApp(api) {
  const requested = argValue("--github-app-uuid") ?? argValue("--github-app");
  const apps = await api("/github-apps");
  const app = requested
    ? apps.find((item) => item.uuid === requested || item.name === requested)
    : apps.find((item) => item.organization === githubAppOrg);
  if (!app) {
    fail(`No encontre GitHub App para ${githubAppOrg}.`);
  }
  return app;
}

async function ensureProject(api) {
  const projects = await api("/projects");
  const existing = projects.find((project) => project.name === projectName);
  if (existing) return existing;

  const created = await api("/projects", {
    method: "POST",
    body: JSON.stringify({
      name: projectName,
      description: "Shape Meet demo and staging resources.",
    }),
  });
  return { uuid: created.uuid, name: projectName };
}

async function ensureEnvironment(api, projectUuid) {
  const environments = await api(`/projects/${projectUuid}/environments`);
  const existing = environments.find(
    (environment) => environment.name === environmentName,
  );
  if (existing) return existing;

  const created = await api(`/projects/${projectUuid}/environments`, {
    method: "POST",
    body: JSON.stringify({ name: environmentName }),
  });
  return { uuid: created.uuid, name: environmentName };
}

async function ensureApplication(
  api,
  { projectUuid, environmentUuid, serverUuid, githubAppUuid },
) {
  const applications = await api("/applications");
  const existing = applications.find(
    (application) =>
      application.name === applicationName ||
      (application.git_repository === repository &&
        application.git_branch === branch),
  );
  const payload = {
    name: applicationName,
    description: "Shape Meet remote demo stack.",
    project_uuid: projectUuid,
    environment_uuid: environmentUuid,
    server_uuid: serverUuid,
    github_app_uuid: githubAppUuid,
    git_repository: repository,
    git_branch: branch,
    build_pack: "dockercompose",
    docker_compose_location: composeLocation,
    docker_compose_domains: [
      {
        name: "shape-admin",
        domain: `https://${adminDomain}:3000`,
      },
      {
        name: "shape-livekit",
        domain: `https://${livekitDomain}:7880`,
      },
    ],
    is_auto_deploy_enabled: true,
    is_force_https_enabled: true,
    force_domain_override: false,
    instant_deploy: false,
  };

  if (existing) {
    try {
      await api(`/applications/${existing.uuid}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
    } catch (error) {
      if (!String(error.message).includes("Cannot set docker_compose_domains")) {
        throw error;
      }
      const { docker_compose_domains: _domains, ...withoutDomains } = payload;
      await api(`/applications/${existing.uuid}`, {
        method: "PATCH",
        body: JSON.stringify(withoutDomains),
      });
    }
    return { uuid: existing.uuid, name: existing.name };
  }

  const created = await api("/applications/private-github-app", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return { uuid: created.uuid, name: applicationName };
}

async function renderEnvFile() {
  const envPath = join(outputDir, "shape-meet.coolify.env");
  const commandArgs = [
    "scripts/render-coolify-env.mjs",
    "--admin-domain",
    adminDomain,
    "--meeting-domain",
    adminDomain,
    "--livekit-domain",
    livekitDomain,
    "--turn-domain",
    turnDomain,
    "--public-ip",
    publicIp,
    "--bootstrap-email",
    bootstrapEmail,
    "--release",
    release,
    "--admin-http-port",
    argValue("--admin-http-port") ?? "18080",
    "--livekit-http-port",
    argValue("--livekit-http-port") ?? "17880",
    "--livekit-rtc-tcp-port",
    argValue("--livekit-rtc-tcp-port") ?? "17881",
    "--livekit-rtc-udp-port",
    argValue("--livekit-rtc-udp-port") ?? "17882",
    "--turn-udp-port",
    argValue("--turn-udp-port") ?? "3478",
    "--turn-tls-port",
    argValue("--turn-tls-port") ?? "5349",
    "--relay-start",
    argValue("--relay-start") ?? "30000",
    "--relay-end",
    argValue("--relay-end") ?? "30100",
    "--out",
    envPath,
  ];
  if (sentryDsn) commandArgs.push("--sentry-dsn", sentryDsn);

  const result = spawnSync(process.execPath, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(redact(result.stdout));
    if (result.stderr) process.stderr.write(redact(result.stderr));
    fail(`No se pudo generar env Coolify: exit ${result.status}`);
  }

  const passwordMatch = `${result.stdout}\n${result.stderr}`.match(
    /Bootstrap password:\s*(.+)$/m,
  );
  if (passwordMatch) {
    writeFileSync(
      join(outputDir, "bootstrap-password.txt"),
      `${passwordMatch[1].trim()}\n`,
      { flag: existsSync(join(outputDir, "bootstrap-password.txt")) ? "w" : "wx" },
    );
  }

  return envPath;
}

function parseEnvFile(path) {
  const values = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;
    const key = line.slice(0, equalsIndex);
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

async function upsertEnvironmentVariables(api, uuid, env) {
  const data = Object.entries(env).map(([key, value]) => ({
    key,
    value,
    is_preview: false,
    is_literal: true,
    is_multiline: false,
    is_shown_once: isSensitiveKey(key),
    is_runtime: true,
    is_buildtime: true,
  }));
  await api(`/applications/${uuid}/envs/bulk`, {
    method: "PATCH",
    body: JSON.stringify({ data }),
  });
  console.log(`Environment variables updated: ${data.length}`);
}

async function waitForComposeLoad(api, uuid) {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const application = await api(`/applications/${uuid}`);
    if (application?.docker_compose_raw || application?.docker_compose) {
      return;
    }
    await sleep(3000);
  }
  console.log("Compose load still pending; continuing with deployment request.");
}

async function startDeployment(api, uuid) {
  await api(`/applications/${uuid}/start`, { method: "POST" });
  console.log("Deployment triggered.");
}

function writeRemoteDemoEnv(env) {
  const remotePath = join(outputDir, "remote-demo.env");
  const values = [
    ["# Shape Meet remote demo verifier env."],
    ["SHAPE_REMOTE_ADMIN_URL", env.NEXT_PUBLIC_APP_URL],
    ["SHAPE_REMOTE_LIVEKIT_URL", env.LIVEKIT_URL],
    ["SHAPE_REMOTE_TURN_HOST", env.LIVEKIT_TURN_DOMAIN],
    ["SHAPE_REMOTE_HOST_IDENTIFIER", env.HOST_BOOTSTRAP_EMAIL],
    ["SHAPE_REMOTE_HOST_PASSWORD", env.HOST_BOOTSTRAP_PASSWORD],
    ["SHAPE_REMOTE_ADMIN_IDENTIFIER", env.HOST_BOOTSTRAP_EMAIL],
    ["SHAPE_REMOTE_ADMIN_PASSWORD", env.HOST_BOOTSTRAP_PASSWORD],
    ["LIVEKIT_RTC_TCP_PORT", env.LIVEKIT_RTC_TCP_PORT],
    ["LIVEKIT_TURN_UDP_PORT", env.LIVEKIT_TURN_UDP_PORT],
    ["LIVEKIT_TURN_TLS_PORT", env.LIVEKIT_TURN_TLS_PORT],
    ["LIVEKIT_TURN_SHARED_SECRET", env.LIVEKIT_TURN_SHARED_SECRET],
    ["LIVEKIT_TURN_TTL_SECONDS", env.LIVEKIT_TURN_TTL_SECONDS],
  ];
  writeFileSync(
    remotePath,
    `${values
      .map((entry) =>
        entry.length === 1
          ? entry[0]
          : `${entry[0]}=${quoteEnv(entry[1] ?? "")}`,
      )
      .join("\n")}\n`,
  );
  return remotePath;
}

async function waitForAdminHealth(url) {
  const healthUrl = `${url}/api/health`;
  console.log(`Waiting for admin health: ${healthUrl}`);
  const startedAt = Date.now();
  const timeoutMs = Number(argValue("--health-timeout-ms") ?? 9 * 60 * 1000);
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(healthUrl, { redirect: "manual" });
      if (response.ok) {
        console.log("Remote admin health ok.");
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await sleep(10000);
  }
  console.log(`Remote admin health pending: ${lastError ?? "timeout"}`);
}

function isSensitiveKey(key) {
  return /PASSWORD|SECRET|TOKEN|AUTH|KEY/i.test(key);
}

function redact(value) {
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9|._-]+/g, "Bearer <redacted>")
    .replace(/(PASSWORD|SECRET|TOKEN|AUTH|KEY)=.+/gi, "$1=<redacted>");
}

function redactBase(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return value;
  }
}

function quoteEnv(value) {
  if (value === "") return "";
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function safeTimestamp(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function relativePath(path) {
  return path.startsWith(repoRoot)
    ? path.slice(repoRoot.length + 1)
    : path;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
