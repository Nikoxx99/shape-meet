import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const json = args.includes("--json");
const strict = args.includes("--strict");
const outputDir = resolve(
  argValue("--out") ??
    join("output", "coolify-handoff", safeTimestamp(new Date())),
);
const envFileArg = argValue("--env-file");
const composeSource = resolve("infra/docker-compose.coolify.yml");
const docsSource = resolve("docs/coolify.md");

mkdirSync(outputDir, { recursive: true });

const envFile = envFileArg
  ? resolve(envFileArg)
  : hasDomainInputs()
    ? generateProductionEnv()
    : resolve("infra/env.coolify.example");

if (!existsSync(envFile)) {
  fail(`No existe env file para Coolify: ${envFile}`);
}

const composeOutput = join(outputDir, "docker-compose.coolify.yml");
const readmeOutput = join(outputDir, "README.md");
const manifestOutput = join(outputDir, "manifest.json");
const remoteDemoEnvOutput = join(outputDir, "remote-demo.env");
cpSync(composeSource, composeOutput);

const check = runPnpm([
  "check:coolify",
  relativeArg(envFile),
  ...(strict ? ["--strict"] : []),
]);
const env = parseEnvFile(envFile);
writeRemoteDemoEnv(remoteDemoEnvOutput, env);
const report = {
  ok: check.status === 0,
  generatedAt: new Date().toISOString(),
  strict,
  sourceEnvFile: envFile,
  outputDir,
  compose: composeOutput,
  readme: readmeOutput,
  manifest: manifestOutput,
  remoteDemoEnv: remoteDemoEnvOutput,
  coolify: summarizeEnv(env),
  remoteDemo: summarizeRemoteDemoEnv(env),
  firewall: firewallChecklist(env),
  check,
  nextSteps: nextSteps(env, remoteDemoEnvOutput),
};

writeFileSync(manifestOutput, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(readmeOutput, readme(report));

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printReport(report);
}

if (!report.ok) process.exit(1);

function generateProductionEnv() {
  const envOutput = join(outputDir, "shape-meet.coolify.env");
  const commandArgs = [
    "scripts/render-coolify-env.mjs",
    "--admin-domain",
    requiredArg("--admin-domain"),
    "--livekit-domain",
    requiredArg("--livekit-domain"),
    "--turn-domain",
    requiredArg("--turn-domain"),
    "--public-ip",
    requiredArg("--public-ip"),
    "--out",
    envOutput,
  ];

  for (const name of [
    "--meeting-domain",
    "--bootstrap-email",
    "--sentry-dsn",
    "--sentry-org",
    "--sentry-project",
    "--sentry-auth-token",
    "--turn-tls-port",
    "--relay-start",
    "--relay-end",
    "--release",
    "--run-seed",
    "--debug-errors",
  ]) {
    const value = argValue(name);
    if (value) commandArgs.push(name, value);
  }

  const result = spawnSync(process.execPath, commandArgs, {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    fail(`No se pudo generar env Coolify: exit ${result.status}`);
  }

  const bootstrapMatch = result.stdout.match(/Bootstrap password:\s*(.+)$/m);
  if (bootstrapMatch) {
    writeFileSync(
      join(outputDir, "bootstrap-password.txt"),
      `${bootstrapMatch[1].trim()}\n`,
      { flag: "wx" },
    );
  }

  return envOutput;
}

function hasDomainInputs() {
  return Boolean(
    argValue("--admin-domain") ||
    argValue("--livekit-domain") ||
    argValue("--turn-domain") ||
    argValue("--public-ip"),
  );
}

function summarizeEnv(env) {
  return {
    adminUrl: env.NEXT_PUBLIC_APP_URL ?? null,
    meetingUrl: env.VITE_SHAPE_MEETING_URL ?? null,
    livekitUrl: env.LIVEKIT_URL ?? null,
    turnDomain: env.LIVEKIT_TURN_DOMAIN ?? null,
    turnExternalIp: env.LIVEKIT_TURN_EXTERNAL_IP ?? null,
    adminPort: env.ADMIN_HTTP_PORT ?? null,
    livekitHttpPort: env.LIVEKIT_HTTP_PORT ?? null,
    livekitRtcTcpPort: env.LIVEKIT_RTC_TCP_PORT ?? null,
    livekitRtcUdpPort: env.LIVEKIT_RTC_UDP_PORT ?? null,
    turnUdpPort: env.LIVEKIT_TURN_UDP_PORT ?? null,
    turnTlsPort: env.LIVEKIT_TURN_TLS_PORT ?? null,
    turnRelayRange:
      env.LIVEKIT_TURN_RELAY_RANGE_START && env.LIVEKIT_TURN_RELAY_RANGE_END
        ? `${env.LIVEKIT_TURN_RELAY_RANGE_START}-${env.LIVEKIT_TURN_RELAY_RANGE_END}/udp`
        : null,
    corsOrigin: env.CORS_ORIGIN ?? null,
    runSeed: env.RUN_SEED ?? null,
    debugErrors: env.SHAPE_DEBUG_ERRORS ?? null,
    sentryConfigured: Boolean(env.SENTRY_DSN || env.NEXT_PUBLIC_SENTRY_DSN),
  };
}

function summarizeRemoteDemoEnv(env) {
  return {
    adminUrl: env.NEXT_PUBLIC_APP_URL ?? env.VITE_SHAPE_API_URL ?? null,
    livekitUrl: env.LIVEKIT_URL ?? null,
    turnHost: env.LIVEKIT_TURN_DOMAIN ?? null,
    hostIdentifier:
      env.VITE_SHAPE_HOST_IDENTIFIER ?? env.HOST_BOOTSTRAP_EMAIL ?? null,
    adminIdentifier:
      env.HOST_BOOTSTRAP_EMAIL ?? env.ADMIN_BOOTSTRAP_EMAIL ?? null,
    hasHostPassword: Boolean(env.HOST_BOOTSTRAP_PASSWORD),
    hasAdminPassword: Boolean(
      env.ADMIN_BOOTSTRAP_PASSWORD ?? env.HOST_BOOTSTRAP_PASSWORD,
    ),
    hasTurnSharedSecret: Boolean(env.LIVEKIT_TURN_SHARED_SECRET),
  };
}

function nextSteps(env, remoteDemoEnvPath) {
  const adminUrl = env.NEXT_PUBLIC_APP_URL ?? "https://admin.tudominio.com";
  const envPath = relativeArg(envFile);
  const remoteEnvPath = relativeArg(remoteDemoEnvPath);
  return [
    "Crear un recurso Docker Compose en Coolify apuntando a Luxora-Agency/shape-meet, branch main, compose infra/docker-compose.coolify.yml.",
    `Copiar las variables de ${envPath} al recurso de Coolify.`,
    "Aplicar la matriz de firewall/routing del README antes del primer test WebRTC remoto.",
    "Desplegar una vez con RUN_SEED=true, entrar con el bootstrap y crear hosts reales.",
    "Cambiar RUN_SEED=false y redeploy.",
    `Validar health: ${adminUrl}/api/health.`,
    `Correr: pnpm demo:remote:check -- --env-file ${remoteEnvPath} --api-flow --identity-flow --strict.`,
    `Actualizar el estado del demo: pnpm demo:status -- --remote-env-file ${remoteEnvPath} --remote-api-flow --remote-identity-flow.`,
  ];
}

function writeRemoteDemoEnv(path, env) {
  const adminUrl = env.NEXT_PUBLIC_APP_URL ?? env.VITE_SHAPE_API_URL ?? "";
  const livekitUrl = env.LIVEKIT_URL ?? "";
  const turnHost = env.LIVEKIT_TURN_DOMAIN ?? "";
  const hostIdentifier =
    env.VITE_SHAPE_HOST_IDENTIFIER ?? env.HOST_BOOTSTRAP_EMAIL ?? "";
  const hostPassword = env.HOST_BOOTSTRAP_PASSWORD ?? "";
  const adminIdentifier =
    env.ADMIN_BOOTSTRAP_EMAIL ?? env.HOST_BOOTSTRAP_EMAIL ?? hostIdentifier;
  const adminPassword = env.ADMIN_BOOTSTRAP_PASSWORD ?? hostPassword;
  const values = [
    ["# Shape Meet remote demo verifier env."],
    [
      "# Do not paste this file into Coolify; keep it local because it contains demo credentials.",
    ],
    ["SHAPE_REMOTE_ADMIN_URL", adminUrl],
    ["SHAPE_REMOTE_LIVEKIT_URL", livekitUrl],
    ["SHAPE_REMOTE_TURN_HOST", turnHost],
    ["SHAPE_REMOTE_HOST_IDENTIFIER", hostIdentifier],
    ["SHAPE_REMOTE_HOST_PASSWORD", hostPassword],
    ["SHAPE_REMOTE_ADMIN_IDENTIFIER", adminIdentifier],
    ["SHAPE_REMOTE_ADMIN_PASSWORD", adminPassword],
    ["LIVEKIT_RTC_TCP_PORT", env.LIVEKIT_RTC_TCP_PORT ?? "7881"],
    ["LIVEKIT_TURN_UDP_PORT", env.LIVEKIT_TURN_UDP_PORT ?? "3478"],
    ["LIVEKIT_TURN_TLS_PORT", env.LIVEKIT_TURN_TLS_PORT ?? "5349"],
    ["LIVEKIT_TURN_SHARED_SECRET", env.LIVEKIT_TURN_SHARED_SECRET ?? ""],
    ["LIVEKIT_TURN_TTL_SECONDS", env.LIVEKIT_TURN_TTL_SECONDS ?? "14400"],
  ];

  const content = `${values
    .map((entry) =>
      entry.length === 1
        ? entry[0]
        : `${entry[0]}=${quoteEnv(entry[1] ?? "")}`,
    )
    .join("\n")}\n`;

  writeFileSync(path, content);
}

function firewallChecklist(env) {
  const adminHost = hostnameFromUrl(env.NEXT_PUBLIC_APP_URL);
  const livekitHost = hostnameFromUrl(env.LIVEKIT_URL);
  const turnHost = env.LIVEKIT_TURN_DOMAIN ?? "turn.tudominio.com";
  const relayStart = env.LIVEKIT_TURN_RELAY_RANGE_START ?? "30000";
  const relayEnd = env.LIVEKIT_TURN_RELAY_RANGE_END ?? "30100";

  return [
    {
      id: "admin-http",
      destination: adminHost ?? "admin.tudominio.com",
      protocol: "HTTPS",
      externalPort: "443/tcp",
      target: "shape-admin:3000/tcp via Coolify HTTP proxy",
      purpose: "Admin API, panel web y launcher publico.",
    },
    {
      id: "livekit-signaling",
      destination: livekitHost ?? "livekit.tudominio.com",
      protocol: "WSS/HTTPS",
      externalPort: "443/tcp",
      target: "shape-livekit:7880/tcp via Coolify HTTP proxy",
      purpose: "Signaling LiveKit y emision de conexion WebRTC.",
    },
    {
      id: "livekit-rtc-tcp",
      destination: livekitHost ?? "livekit.tudominio.com",
      protocol: "TCP",
      externalPort: `${env.LIVEKIT_RTC_TCP_PORT ?? "7881"}/tcp`,
      target: "shape-livekit rtc.tcp_port",
      purpose: "Fallback ICE TCP directo hacia LiveKit.",
    },
    {
      id: "livekit-rtc-udp",
      destination: livekitHost ?? "livekit.tudominio.com",
      protocol: "UDP",
      externalPort: `${env.LIVEKIT_RTC_UDP_PORT ?? "7882"}/udp`,
      target: "shape-livekit rtc.udp_port",
      purpose: "Media WebRTC UDP directo hacia LiveKit.",
    },
    {
      id: "turn-udp-tcp",
      destination: turnHost,
      protocol: "UDP/TCP",
      externalPort: `${env.LIVEKIT_TURN_UDP_PORT ?? "3478"}/udp,tcp`,
      target: "shape-turn listening-port",
      purpose: "STUN/TURN principal con auth REST compartida.",
    },
    {
      id: "turn-tls",
      destination: turnHost,
      protocol: "TLS/DTLS",
      externalPort: `${env.LIVEKIT_TURN_TLS_PORT ?? "5349"}/tcp,udp`,
      target: "shape-turn tls-listening-port",
      purpose: "TURN/TLS para redes restrictivas.",
    },
    {
      id: "turn-relay-udp-range",
      destination: turnHost,
      protocol: "UDP",
      externalPort: `${relayStart}-${relayEnd}/udp`,
      target: "shape-turn relay min/max ports",
      purpose: "Puertos relay asignados por coturn para medios.",
    },
  ];
}

function hostnameFromUrl(value) {
  if (!value) return null;
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

function readme(report) {
  const coolify = report.coolify;
  const remoteEnvPath = relativeArg(report.remoteDemoEnv);
  const firewallRows = report.firewall
    .map(
      (entry) =>
        `| ${entry.destination} | ${entry.externalPort} | ${entry.target} | ${entry.purpose} |`,
    )
    .join("\n");
  const lines = [
    "# Shape Meet Coolify Handoff",
    "",
    `Generado: ${report.generatedAt}`,
    `Estado: ${report.ok ? "ok" : "revisar"}`,
    "",
    "## Recurso Coolify",
    "",
    "- Resource type: Docker Compose",
    "- Repository: `Luxora-Agency/shape-meet`",
    "- Branch: `main`",
    "- Compose file: `infra/docker-compose.coolify.yml`",
    "- Build context: repository root",
    "- Admin service port: `3000`",
    "",
    "No definas `NODE_ENV`, `HOST` ni `PORT` en Coolify para `shape-admin`.",
    "",
    "## Variables",
    "",
    `Env validado: \`${relativeArg(report.sourceEnvFile)}\``,
    `Env local de verificación remota: \`${remoteEnvPath}\``,
    `Admin: ${coolify.adminUrl ?? "pendiente"}`,
    `Meeting: ${coolify.meetingUrl ?? "pendiente"}`,
    `LiveKit: ${coolify.livekitUrl ?? "pendiente"}`,
    `TURN: ${coolify.turnDomain ?? "pendiente"}`,
    `TURN external IP: ${coolify.turnExternalIp ?? "pendiente"}`,
    `CORS origin: ${coolify.corsOrigin ?? "pendiente"}`,
    `RUN_SEED: ${coolify.runSeed ?? "pendiente"}`,
    `SHAPE_DEBUG_ERRORS: ${coolify.debugErrors ?? "pendiente"}`,
    `Sentry: ${coolify.sentryConfigured ? "configurado" : "sin DSN"}`,
    "",
    "## Puertos",
    "",
    `- Admin HTTP: ${coolify.adminPort ?? "3000"}/tcp`,
    `- LiveKit HTTP/WebSocket: ${coolify.livekitHttpPort ?? "7880"}/tcp`,
    `- LiveKit RTC TCP: ${coolify.livekitRtcTcpPort ?? "7881"}/tcp`,
    `- LiveKit RTC UDP: ${coolify.livekitRtcUdpPort ?? "7882"}/udp`,
    `- TURN UDP/TCP: ${coolify.turnUdpPort ?? "3478"}/udp,tcp`,
    `- TURN TLS/DTLS: ${coolify.turnTlsPort ?? "5349"}/tcp,udp`,
    `- TURN relay: ${coolify.turnRelayRange ?? "30000-30100/udp"}`,
    "",
    "## Firewall y routing",
    "",
    "| Destino | Puerto externo | Target interno | Uso |",
    "| --- | --- | --- | --- |",
    firewallRows,
    "",
    "Notas:",
    "- `shape-admin` y `shape-livekit:7880` van por el proxy HTTP/TLS de Coolify.",
    "- RTC, TURN y relay UDP/TCP deben exponerse directamente en firewall o L4; no dependen del proxy HTTP.",
    "- Para máxima compatibilidad corporativa, publica TURN/TLS en `443/tcp` con IP dedicada o L4/SNI si el proxy HTTP ya usa 443.",
    "",
    "## Validación",
    "",
    "```bash",
    `pnpm check:coolify ${relativeArg(report.sourceEnvFile)}${report.strict ? " --strict" : ""}`,
    `pnpm demo:remote:check -- --env-file ${remoteEnvPath} --api-flow --identity-flow --strict`,
    `pnpm demo:status -- --remote-env-file ${remoteEnvPath} --remote-api-flow --remote-identity-flow`,
    "```",
    "",
    "`remote-demo.env` es sensible: contiene credenciales de demo para ejecutar el verificador desde tu equipo, no para pegarlas en el panel de Coolify.",
    "",
    "## Pasos",
    "",
    ...report.nextSteps.map((step, index) => `${index + 1}. ${step}`),
    "",
    "## Check Output",
    "",
    "```text",
    trimForReadme(report.check.stdout || report.check.stderr || ""),
    "```",
    "",
  ];

  if (existsSync(docsSource)) {
    lines.push("Guía larga: `docs/coolify.md`.", "");
  }

  return `${lines.join("\n")}`;
}

function runPnpm(commandArgs) {
  const result = spawnSync(pnpmCommand(), commandArgs, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    command: `pnpm ${commandArgs.join(" ")}`,
    status: result.status,
    stdout: trim(result.stdout),
    stderr: trim(result.stderr),
  };
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

function printReport(report) {
  console.log("Shape Meet Coolify handoff");
  console.log(`Output: ${report.outputDir}`);
  console.log(`Env: ${relativeArg(report.sourceEnvFile)}`);
  console.log(`Check: ${report.check.status === 0 ? "ok" : "failed"}`);
  console.log(`Manifest: ${report.manifest}`);
}

function requiredArg(name) {
  const value = argValue(name);
  if (!value) fail(`Missing required argument: ${name}`);
  return value;
}

function argValue(name) {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

function relativeArg(path) {
  const absolute = resolve(path);
  const relativePath = absolute.startsWith(process.cwd())
    ? absolute.slice(process.cwd().length + 1)
    : path;
  return relativePath || ".";
}

function safeTimestamp(date) {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function trim(value) {
  return String(value ?? "").trim();
}

function trimForReadme(value) {
  const text = trim(value);
  return text.length > 4000 ? `${text.slice(0, 4000)}\n...` : text;
}

function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function quoteEnv(value) {
  if (value === "") return "";
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
