import { createHmac, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createSocket } from "node:dgram";
import { Socket } from "node:net";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const json = args.includes("--json");
const skipNetwork = args.includes("--skip-network");
const skipTurnutils = args.includes("--skip-turnutils");
const timeoutMs = Number(argValue("--timeout-ms") ?? "5000");
const envFile = argValue("--env-file");
const outputPath = argValue("--output");
const env = {
  ...(envFile ? readEnvFile(resolve(envFile)) : {}),
  ...process.env,
};
const checks = [];
const warnings = [];
const issues = [];

const adminUrl = normalizeUrl(
  argValue("--admin-url") ??
    env.SHAPE_REMOTE_ADMIN_URL ??
    env.NEXT_PUBLIC_APP_URL ??
    env.VITE_SHAPE_API_URL,
);
const livekitUrl = normalizeUrl(
  argValue("--livekit-url") ?? env.SHAPE_REMOTE_LIVEKIT_URL ?? env.LIVEKIT_URL,
);
const turnHost =
  argValue("--turn-host") ??
  env.SHAPE_REMOTE_TURN_HOST ??
  env.LIVEKIT_TURN_DOMAIN;
const rtcTcpPort = parsePort(
  argValue("--rtc-tcp-port") ?? env.LIVEKIT_RTC_TCP_PORT ?? "7881",
  "LIVEKIT_RTC_TCP_PORT",
);
const turnUdpPort = parsePort(
  argValue("--turn-udp-port") ?? env.LIVEKIT_TURN_UDP_PORT ?? "3478",
  "LIVEKIT_TURN_UDP_PORT",
);
const turnTlsPort = parsePort(
  argValue("--turn-tls-port") ?? env.LIVEKIT_TURN_TLS_PORT ?? "5349",
  "LIVEKIT_TURN_TLS_PORT",
);
const turnTtlSeconds = parsePositiveInteger(
  env.LIVEKIT_TURN_TTL_SECONDS ?? "14400",
  "LIVEKIT_TURN_TTL_SECONDS",
);
const turnSecret = env.LIVEKIT_TURN_SHARED_SECRET;

await main();

async function main() {
  checkRequiredConfig();
  checkProtocols();

  if (!skipNetwork && issues.length === 0) {
    await runNetworkChecks();
  }

  const status =
    issues.length > 0 ? "failed" : warnings.length > 0 ? "warning" : "passed";
  const report = {
    status,
    checkedAt: new Date().toISOString(),
    target: {
      adminUrl,
      livekitUrl,
      turnHost,
      rtcTcpPort,
      turnUdpPort,
      turnTlsPort,
    },
    checks,
    warnings,
    issues,
  };

  if (outputPath) writeReport(outputPath, report);

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  if (issues.length > 0 || (strict && warnings.length > 0)) {
    process.exit(1);
  }
}

function writeReport(path, report) {
  const absolutePath = resolve(path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  checks.push(
    check(
      "report.output",
      "ok",
      `Reporte remoto escrito: ${absolutePath}`,
      null,
    ),
  );
  writeFileSync(absolutePath, `${JSON.stringify(report, null, 2)}\n`);
}

function checkRequiredConfig() {
  if (!adminUrl)
    issue("config.admin", "Falta NEXT_PUBLIC_APP_URL o --admin-url.");
  else ok("config.admin", `Admin: ${adminUrl}`);

  if (!livekitUrl)
    issue("config.livekit", "Falta LIVEKIT_URL o --livekit-url.");
  else ok("config.livekit", `LiveKit: ${livekitUrl}`);

  if (!turnHost)
    issue("config.turn", "Falta LIVEKIT_TURN_DOMAIN o --turn-host.");
  else ok("config.turn", `TURN: ${turnHost}`);
}

function checkProtocols() {
  const admin = safeUrl(adminUrl);
  const livekit = safeUrl(livekitUrl);

  if (admin && !isLocalHost(admin.hostname) && admin.protocol !== "https:") {
    warning("config.admin-protocol", "Admin remoto debería usar https://.");
  }

  if (
    livekit &&
    !isLocalHost(livekit.hostname) &&
    livekit.protocol !== "wss:"
  ) {
    warning("config.livekit-protocol", "LiveKit remoto debería usar wss://.");
  }

  if (
    livekit &&
    turnHost &&
    livekit.hostname === turnHost &&
    !isLocalHost(livekit.hostname)
  ) {
    issue(
      "config.turn-domain",
      "LIVEKIT_URL y LIVEKIT_TURN_DOMAIN deben usar dominios separados.",
    );
  }
}

async function runNetworkChecks() {
  await checkAdminHealth();
  await checkLiveKitHttp();
  await checkDns();

  const livekit = safeUrl(livekitUrl);
  if (livekit && rtcTcpPort) {
    await checkTcp(
      "network.livekit-rtc-tcp",
      livekit.hostname,
      rtcTcpPort,
      "LiveKit RTC TCP",
    );
  }

  if (turnHost && turnUdpPort) {
    await checkTcp("network.turn-tcp", turnHost, turnUdpPort, "TURN TCP");
    await checkStunUdp();
  }

  if (turnHost && turnTlsPort) {
    await checkTcp(
      "network.turn-tls-tcp",
      turnHost,
      turnTlsPort,
      "TURN TLS TCP",
    );
  }

  await checkTurnRestAuth();
}

async function checkAdminHealth() {
  const healthUrl = `${adminUrl.replace(/\/$/, "")}/api/health`;
  const started = Date.now();

  try {
    const response = await fetchWithTimeout(healthUrl, timeoutMs);
    const text = await response.text();
    const data = parseJson(text);
    if (!response.ok) {
      issue(
        "network.admin-health",
        `Admin health devolvió HTTP ${response.status}.`,
        started,
      );
      return;
    }
    if (data?.ok !== true || data?.database !== "ok") {
      issue(
        "network.admin-health",
        `Admin health respondió sin ok/database=ok: ${text.slice(0, 160)}`,
        started,
      );
      return;
    }
    ok("network.admin-health", "Admin /api/health ok.", started);
    checkAdminLiveKitConfig(data, started);
  } catch (error) {
    issue("network.admin-health", errorMessage(error), started);
  }
}

function checkAdminLiveKitConfig(data, started) {
  const livekit = data?.livekit;

  if (!livekit || typeof livekit !== "object") {
    warning(
      "network.admin-livekit-config",
      "Admin health no reporta configuración LiveKit; redeploya una versión reciente antes del demo.",
      started,
    );
    return;
  }

  if (livekit.status !== "ok") {
    const missing = [];
    if (livekit.urlConfigured !== true) missing.push("LIVEKIT_URL");
    if (livekit.credentialsConfigured !== true)
      missing.push("LIVEKIT_API_KEY/LIVEKIT_API_SECRET");
    issue(
      "network.admin-livekit-config",
      `Admin no está listo para emitir tokens LiveKit${
        missing.length ? `; falta ${missing.join(", ")}` : ""
      }.`,
      started,
    );
    return;
  }

  ok(
    "network.admin-livekit-config",
    "Admin tiene LiveKit URL y credenciales configuradas para emitir tokens.",
    started,
  );
}

async function checkLiveKitHttp() {
  const httpUrl = liveKitHttpUrl(livekitUrl);
  const started = Date.now();

  try {
    const response = await fetchWithTimeout(httpUrl, timeoutMs);
    if (!response.ok) {
      issue(
        "network.livekit-http",
        `LiveKit HTTP devolvió ${response.status}.`,
        started,
      );
      return;
    }
    ok(
      "network.livekit-http",
      `LiveKit signaling responde en ${httpUrl}.`,
      started,
    );
  } catch (error) {
    issue("network.livekit-http", errorMessage(error), started);
  }
}

async function checkDns() {
  const started = Date.now();

  try {
    const records = await lookup(turnHost, { all: true });
    if (records.length === 0) {
      issue("network.turn-dns", `TURN no resolvió DNS: ${turnHost}.`, started);
      return;
    }
    ok(
      "network.turn-dns",
      `TURN DNS: ${records.map((record) => record.address).join(", ")}.`,
      started,
    );
  } catch (error) {
    issue("network.turn-dns", errorMessage(error), started);
  }
}

async function checkTcp(id, host, port, label) {
  const started = Date.now();

  try {
    await tcpConnect(host, port, timeoutMs);
    ok(id, `${label} abierto en ${host}:${port}.`, started);
  } catch (error) {
    issue(
      id,
      `${label} no conecta en ${host}:${port}: ${errorMessage(error)}`,
      started,
    );
  }
}

async function checkStunUdp() {
  const started = Date.now();

  try {
    const response = await stunBindingRequest(turnHost, turnUdpPort, timeoutMs);
    ok(
      "network.turn-stun-udp",
      `TURN UDP respondió STUN ${response.type} desde ${response.remote}.`,
      started,
    );
  } catch (error) {
    issue(
      "network.turn-stun-udp",
      `TURN UDP/STUN falló: ${errorMessage(error)}`,
      started,
    );
  }
}

async function checkTurnRestAuth() {
  if (skipTurnutils) {
    skipped("network.turn-auth", "turnutils_uclient omitido por flag.");
    return;
  }

  if (!turnSecret || isPlaceholder(turnSecret)) {
    warning(
      "network.turn-auth",
      "Sin LIVEKIT_TURN_SHARED_SECRET real; se omite auth TURN REST.",
    );
    return;
  }

  const available = spawnSync("turnutils_uclient", ["-h"], {
    encoding: "utf8",
  });
  if (available.error?.code === "ENOENT") {
    warning(
      "network.turn-auth",
      "turnutils_uclient no está instalado; instala coturn para validar auth TURN REST end-to-end.",
    );
    return;
  }

  const started = Date.now();
  const username = `${Math.floor(Date.now() / 1000) + turnTtlSeconds}:shape-remote-check`;
  const password = createHmac("sha1", turnSecret)
    .update(username)
    .digest("base64");
  const result = spawnSync(
    "turnutils_uclient",
    [
      "-u",
      username,
      "-w",
      password,
      "-n",
      "1",
      "-m",
      "1",
      "-y",
      "-p",
      String(turnUdpPort),
      turnHost,
    ],
    {
      encoding: "utf8",
      timeout: timeoutMs + 1000,
    },
  );

  if (result.status === 0) {
    ok(
      "network.turn-auth",
      "TURN REST auth validada con turnutils_uclient.",
      started,
    );
    return;
  }

  issue(
    "network.turn-auth",
    `turnutils_uclient falló: ${redact([result.stderr, result.stdout].filter(Boolean).join("\n")).slice(0, 400)}`,
    started,
  );
}

async function fetchWithTimeout(url, timeout) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function tcpConnect(host, port, timeout) {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const timer = setTimeout(() => {
      socket.destroy(new Error("timeout"));
    }, timeout);

    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("timeout", () => {
      clearTimeout(timer);
      reject(new Error("timeout"));
    });
    socket.connect(port, host);
  });
}

function stunBindingRequest(host, port, timeout) {
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    const transactionId = randomBytes(12);
    const request = Buffer.alloc(20);
    request.writeUInt16BE(0x0001, 0);
    request.writeUInt16BE(0, 2);
    request.writeUInt32BE(0x2112a442, 4);
    transactionId.copy(request, 8);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("timeout"));
    }, timeout);

    socket.once("message", (message, remote) => {
      clearTimeout(timer);
      socket.close();
      if (message.length < 20) {
        reject(new Error("respuesta STUN demasiado corta"));
        return;
      }
      if (message.readUInt32BE(4) !== 0x2112a442) {
        reject(new Error("magic cookie STUN inválida"));
        return;
      }
      if (!message.subarray(8, 20).equals(transactionId)) {
        reject(new Error("transaction id STUN no coincide"));
        return;
      }
      resolve({
        type: `0x${message.readUInt16BE(0).toString(16).padStart(4, "0")}`,
        remote: `${remote.address}:${remote.port}`,
      });
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.close();
      reject(error);
    });
    socket.send(request, port, host);
  });
}

function liveKitHttpUrl(value) {
  const parsed = new URL(value);
  if (parsed.protocol === "ws:") parsed.protocol = "http:";
  if (parsed.protocol === "wss:") parsed.protocol = "https:";
  return parsed.toString().replace(/\/$/, "");
}

function ok(id, detail, started = null) {
  checks.push(check(id, "ok", detail, started));
}

function warning(id, detail, started = null) {
  warnings.push(detail);
  checks.push(check(id, "warning", detail, started));
}

function issue(id, detail, started = null) {
  issues.push(detail);
  checks.push(check(id, "failed", detail, started));
}

function skipped(id, detail) {
  checks.push(check(id, "skipped", detail, null));
}

function check(id, status, detail, started) {
  return {
    id,
    status,
    detail,
    durationMs: started ? Date.now() - started : null,
  };
}

function printReport(report) {
  console.log("Shape Meet remote demo check");
  console.log(`Estado: ${report.status}`);
  console.log(`Admin: ${report.target.adminUrl ?? "no configurado"}`);
  console.log(`LiveKit: ${report.target.livekitUrl ?? "no configurado"}`);
  console.log(`TURN: ${report.target.turnHost ?? "no configurado"}`);
  console.log("");
  for (const item of report.checks) {
    const elapsed = item.durationMs === null ? "" : ` (${item.durationMs} ms)`;
    console.log(`${item.status}: ${item.id}: ${item.detail}${elapsed}`);
  }
}

function readEnvFile(path) {
  if (!existsSync(path)) {
    console.error(`Env file not found: ${path}`);
    process.exit(1);
  }

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

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parsePort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    issue(`config.${label}`, `${label} debe ser un puerto válido.`);
    return null;
  }
  return port;
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    issue(`config.${label}`, `${label} debe ser entero positivo.`);
    return 14400;
  }
  return parsed;
}

function normalizeUrl(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed.replace(/\/$/, "") : null;
}

function safeUrl(value) {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    issue("config.url", `URL inválida: ${value}`);
    return null;
  }
}

function argValue(name) {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

function isLocalHost(hostname) {
  return ["localhost", "127.0.0.1", "::1"].includes(hostname);
}

function isPlaceholder(value) {
  return [
    /^replace/i,
    /change-me/i,
    /^secret$/i,
    /^devkey$/i,
    /^shape-turn-local-secret$/i,
    /^shape-turn-dev-secret$/i,
  ].some((pattern) => pattern.test(String(value ?? "")));
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function redact(value) {
  let output = String(value);
  for (const secret of [turnSecret].filter(Boolean)) {
    output = output.replaceAll(secret, "[redacted]");
  }
  return output;
}
