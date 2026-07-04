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
cpSync(composeSource, composeOutput);

const check = runPnpm([
  "check:coolify",
  relativeArg(envFile),
  ...(strict ? ["--strict"] : []),
]);
const env = parseEnvFile(envFile);
const report = {
  ok: check.status === 0,
  generatedAt: new Date().toISOString(),
  strict,
  sourceEnvFile: envFile,
  outputDir,
  compose: composeOutput,
  readme: readmeOutput,
  manifest: manifestOutput,
  coolify: summarizeEnv(env),
  check,
  nextSteps: nextSteps(env),
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
    runSeed: env.RUN_SEED ?? null,
    debugErrors: env.SHAPE_DEBUG_ERRORS ?? null,
    sentryConfigured: Boolean(env.SENTRY_DSN || env.NEXT_PUBLIC_SENTRY_DSN),
  };
}

function nextSteps(env) {
  const adminUrl = env.NEXT_PUBLIC_APP_URL ?? "https://admin.tudominio.com";
  const envPath = relativeArg(envFile);
  return [
    "Crear un recurso Docker Compose en Coolify apuntando a Luxora-Agency/shape-meet, branch main, compose infra/docker-compose.coolify.yml.",
    `Copiar las variables de ${envPath} al recurso de Coolify.`,
    "Publicar admin/livekit por proxy HTTP y exponer directamente puertos RTC/TURN en firewall/L4.",
    "Desplegar una vez con RUN_SEED=true, entrar con el bootstrap y crear hosts reales.",
    "Cambiar RUN_SEED=false y redeploy.",
    `Validar health: ${adminUrl}/api/health.`,
    `Correr: pnpm demo:remote:check -- --env-file ${envPath} --api-flow --identity-flow --strict.`,
  ];
}

function readme(report) {
  const coolify = report.coolify;
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
    `Admin: ${coolify.adminUrl ?? "pendiente"}`,
    `Meeting: ${coolify.meetingUrl ?? "pendiente"}`,
    `LiveKit: ${coolify.livekitUrl ?? "pendiente"}`,
    `TURN: ${coolify.turnDomain ?? "pendiente"}`,
    `TURN external IP: ${coolify.turnExternalIp ?? "pendiente"}`,
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
    "## Validación",
    "",
    "```bash",
    `pnpm check:coolify ${relativeArg(report.sourceEnvFile)}${report.strict ? " --strict" : ""}`,
    `pnpm demo:remote:check -- --env-file ${relativeArg(report.sourceEnvFile)} --api-flow --identity-flow --strict`,
    "```",
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

function fail(message) {
  console.error(message);
  process.exit(1);
}
