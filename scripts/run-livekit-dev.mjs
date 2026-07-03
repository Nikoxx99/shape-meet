import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const argSet = new Set(args);
const doctorOnly = argSet.has("--doctor");
const mode = (
  argValue("--mode") ??
  process.env.SHAPE_LIVEKIT_DEV_MODE ??
  "auto"
).toLowerCase();
const env = {
  ...readEnvFile("infra/env.local.example"),
  ...readEnvFile(".env.local"),
  ...readEnvFile("apps/admin/.env.local"),
  ...process.env,
};
const liveKitUrl = (
  argValue("--url") ??
  env.SHAPE_DEMO_LIVEKIT_URL ??
  env.LIVEKIT_DEV_URL ??
  env.LIVEKIT_URL ??
  "ws://localhost:17880"
).replace(/\/$/, "");
const apiKey = argValue("--api-key") ?? env.LIVEKIT_API_KEY ?? "devkey";
const apiSecret =
  argValue("--api-secret") ?? env.LIVEKIT_API_SECRET ?? "secret";

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function main() {
  const httpUrl = liveKitHttpUrl(liveKitUrl);
  const status = await inspectHttp(httpUrl);

  console.log("Shape Meet LiveKit dev");
  console.log(`URL: ${liveKitUrl}`);

  if (status.ok) {
    console.log("Estado: ok");
    return;
  }

  if (doctorOnly) {
    console.log(`Estado: ${status.message}`);
    process.exit(1);
  }

  if (mode !== "docker") {
    const binary = findLiveKitServer();
    if (binary) {
      await runNativeLiveKit(binary);
      return;
    }

    if (mode === "native") {
      throw new Error(
        "No encontré `livekit-server` en PATH. Instálalo o usa `--mode docker`.",
      );
    }
  }

  runDockerLiveKit();
}

async function runNativeLiveKit(binary) {
  const ports = liveKitPorts();
  const configPath = writeNativeConfig(ports);

  console.log(`Modo: native (${binary})`);
  console.log(`Config: ${configPath}`);
  console.log(`RTC TCP: ${ports.tcpPort}`);
  console.log(`RTC UDP: ${ports.udpPort}`);

  const child = spawn(binary, ["--config", configPath], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });

  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) resolve();
      else if (code === 0) resolve();
      else reject(new Error(`livekit-server terminó con código ${code}.`));
    });
  });
}

function runDockerLiveKit() {
  const ports = liveKitPorts();
  const composeEnv = {
    ...process.env,
    LIVEKIT_DEV_HTTP_PORT: String(ports.httpPort),
    LIVEKIT_DEV_RTC_TCP_PORT: String(ports.tcpPort),
    LIVEKIT_DEV_RTC_UDP_PORT: String(ports.udpPort),
  };

  console.log("Modo: docker");
  console.log(
    "> docker compose -p shape-meet-livekit-dev -f infra/docker-compose.livekit.dev.yml up -d",
  );

  const result = spawnSync(
    "docker",
    [
      "compose",
      "-p",
      "shape-meet-livekit-dev",
      "-f",
      "infra/docker-compose.livekit.dev.yml",
      "up",
      "-d",
    ],
    {
      cwd: process.cwd(),
      env: composeEnv,
      encoding: "utf8",
      stdio: "inherit",
    },
  );

  if (result.status !== 0) {
    throw new Error("No se pudo levantar LiveKit dev con Docker.");
  }
}

function writeNativeConfig(ports) {
  const dir = mkdtempSync(join(tmpdir(), "shape-livekit-dev-"));
  const configPath = join(dir, "livekit.yaml");
  const config = [
    `port: ${ports.httpPort}`,
    "log_level: info",
    "rtc:",
    `  tcp_port: ${ports.tcpPort}`,
    `  udp_port: ${ports.udpPort}`,
    "  use_external_ip: false",
    "  enable_loopback_candidate: true",
    "keys:",
    `  ${JSON.stringify(apiKey)}: ${JSON.stringify(apiSecret)}`,
    "",
  ].join("\n");

  writeFileSync(configPath, config);
  return configPath;
}

function liveKitPorts() {
  const target = serviceTarget(liveKitUrl);
  const httpPort = target.port || 17880;
  return {
    httpPort,
    tcpPort: positiveInteger(env.LIVEKIT_DEV_RTC_TCP_PORT, httpPort + 1),
    udpPort: positiveInteger(env.LIVEKIT_DEV_RTC_UDP_PORT, httpPort + 2),
  };
}

function findLiveKitServer() {
  const explicit = env.LIVEKIT_SERVER_BIN ?? env.LIVEKIT_DEV_SERVER_BIN;
  if (explicit && canRun(explicit)) return explicit;

  const candidates =
    process.platform === "win32"
      ? ["livekit-server.exe", "livekit-server"]
      : ["livekit-server"];

  for (const candidate of candidates) {
    if (canRun(candidate)) return candidate;
  }

  return null;
}

function canRun(command) {
  const result = spawnSync(command, ["--help"], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  return result.status === 0 || Boolean(result.stdout || result.stderr);
}

async function inspectHttp(url) {
  try {
    const response = await fetch(url);
    return {
      ok: response.ok,
      message: response.ok ? "ok" : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function liveKitHttpUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol === "ws:") parsed.protocol = "http:";
  if (parsed.protocol === "wss:") parsed.protocol = "https:";
  return parsed.toString().replace(/\/$/, "");
}

function serviceTarget(rawUrl) {
  const parsed = new URL(rawUrl);
  const port = Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80);
  return { host: parsed.hostname, port };
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readEnvFile(path) {
  if (!existsSync(path)) return {};
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

function argValue(name) {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);

  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}
