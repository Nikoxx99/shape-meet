import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const args = new Set(process.argv.slice(2));
const doctorOnly = args.has("--doctor");
const noDocker = args.has("--no-docker");
const noPrepare = args.has("--no-prepare");
const replaceAi = args.has("--replace-ai") || args.has("--restart-ai");
const strict = args.has("--strict");
const verifyUi = args.has("--verify-ui");
const keepAlive = args.has("--keep-alive");
const exitAfterReady =
  args.has("--exit-after-ready") ||
  args.has("--once") ||
  (verifyUi && !keepAlive);
const infraEnv = readEnvFile("infra/env.local.example");
const rootEnv = readEnvFile(".env.local");
const appEnv = {
  ...readEnvFile("apps/admin/.env.local"),
  ...readEnvFile("apps/desktop/.env.local"),
};
const composeEnv = resolveLocalComposeEnv({
  ...infraEnv,
  ...rootEnv,
  ...process.env,
});
const env = {
  ...infraEnv,
  ...rootEnv,
  ...appEnv,
  ...process.env,
};
const adminUrl = (
  env.SHAPE_DEMO_API_URL ??
  env.VITE_SHAPE_API_URL ??
  "http://localhost:13000"
).replace(/\/$/, "");
const appUrl = (
  env.SHAPE_DEMO_APP_URL ??
  env.VITE_SHAPE_MEETING_URL ??
  env.VITE_SHAPE_APP_URL ??
  "http://localhost:1420"
).replace(/\/$/, "");
const aiUrl = (
  env.SHAPE_DEMO_AI_URL ??
  env.VITE_SHAPE_AI_SERVICE_URL ??
  "http://127.0.0.1:7851"
).replace(/\/$/, "");
const liveKitUrl = resolveDemoLiveKitUrl();
const children = [];

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function main() {
  if (verifyUi && noPrepare) {
    throw new Error(
      "`--verify-ui` ejecuta demo:ui, que prepara datos. Quita `--no-prepare`.",
    );
  }

  console.log("Shape Meet demo");
  console.log(`Admin/API: ${adminUrl}`);
  console.log(`Desktop: ${appUrl}`);
  console.log(`IA local: ${aiUrl}`);
  console.log(`LiveKit: ${liveKitUrl}`);
  console.log("");

  let services = await inspectServices();
  printServiceReport(services);
  let liveKitRecreateReason = noDocker ? null : liveKitDemoRecreateReason();
  let adminRecreateReason = noDocker ? null : adminDemoRecreateReason();

  if (doctorOnly) {
    if (adminRecreateReason) {
      console.log(`- Admin/API: ${adminRecreateReason}`);
      console.log("");
    }
    if (liveKitRecreateReason) {
      console.log(`- LiveKit RTC: ${liveKitRecreateReason}`);
      console.log("");
    }
    if (
      strict &&
      (!demoReady(services) || liveKitRecreateReason || adminRecreateReason)
    ) {
      process.exit(1);
    }
    return;
  }

  if (!services.admin.ok && !noDocker) {
    runDockerCompose();
    services = await inspectServices();
    printServiceReport(services);
    liveKitRecreateReason = liveKitDemoRecreateReason();
    adminRecreateReason = adminDemoRecreateReason();
  }

  if (adminRecreateReason) {
    console.log(`${adminRecreateReason}; recrearé el admin local.`);
    recreateAdminCompose();
    services = await inspectServices();
    printServiceReport(services);
    liveKitRecreateReason = liveKitDemoRecreateReason();
  }

  if (liveKitRecreateReason) {
    console.log(`${liveKitRecreateReason}; recrearé LiveKit local.`);
    recreateLiveKitCompose();
    services = await inspectServices();
    printServiceReport(services);
  }

  if (!services.livekit.ok && !noDocker && isLocalLiveKit(liveKitUrl)) {
    if (isFullComposeLiveKitUrl(liveKitUrl)) {
      recreateLiveKitCompose();
    } else {
      runLiveKitDevCompose();
    }
    services = await inspectServices();
    printServiceReport(services);
  }

  if (services.ai.ok && !services.ai.demoReady) {
    if (!replaceAi) {
      throw new Error(
        "IA local ya está activa pero no en modo demo visible. Vuelve a correr con `pnpm demo:up -- --replace-ai` para reemplazar el sidecar local si pertenece a Shape Meet.",
      );
    }

    await replaceExistingAiSidecar();
    services = await inspectServices();
    printServiceReport(services);
  }

  if (!services.ai.ok) {
    startProcess("IA demo", ["dev:ai:demo"]);
  }

  if (!services.desktop.ok) {
    startProcess("Desktop web", [
      "--filter",
      "@shape-meet/desktop",
      "dev:vite",
    ]);
  }

  const ready = await waitForReady();
  printServiceReport(ready);

  if (verifyUi) {
    const verified = runPnpmCapture(["demo:ui"]);
    const link =
      verified.stdout.match(/Demo limpio listo:\s+(\S+)/)?.[1] ??
      verified.stdout.match(/Public link:\s+(\S+)/)?.[1] ??
      appUrl;
    console.log("");
    console.log(`Demo verificado: ${link}`);
  } else if (!noPrepare) {
    const prepared = runPnpmCapture(["demo:prepare"]);
    const link = prepared.stdout.match(/Public link:\s+(\S+)/)?.[1] ?? appUrl;
    console.log("");
    console.log(`Demo listo: ${link}`);
  }

  if (children.length === 0) {
    console.log("");
    console.log(
      "Servicios ya estaban activos. No hay procesos nuevos que mantener.",
    );
    return;
  }

  if (exitAfterReady) {
    console.log("");
    console.log(
      "Demo verificado. Detendré los procesos locales iniciados por este comando.",
    );
    await stopStartedProcesses();
    return;
  }

  console.log("");
  console.log(
    "Demo activo. Ctrl+C detiene los procesos locales iniciados por este comando.",
  );
  await waitForExitSignal();
}

async function inspectServices() {
  const [admin, desktop, livekit, ai] = await Promise.all([
    inspectJson(
      `${adminUrl}/api/health`,
      (data) => data.ok === true && data.database === "ok",
    ),
    inspectHttp(appUrl),
    inspectHttp(liveKitHttpUrl(liveKitUrl)),
    inspectJson(`${aiUrl}/health`, (data) => data.status === "ready"),
  ]);
  const demoReady =
    livekit.ok &&
    ai.ok &&
    ai.data?.mode === "adapter-contract" &&
    ai.data?.diagnostics?.managedProcessors?.some(
      (processor) => processor.id === "video" && processor.status === "running",
    ) &&
    ai.data?.diagnostics?.managedProcessors?.some(
      (processor) => processor.id === "audio" && processor.status === "running",
    );

  return {
    admin,
    desktop,
    livekit,
    ai: {
      ...ai,
      demoReady: Boolean(demoReady),
    },
  };
}

async function waitForReady() {
  let last = await inspectServices();

  for (let attempt = 1; attempt <= 80; attempt += 1) {
    if (demoReady(last)) return last;
    await sleep(1000);
    last = await inspectServices();
  }

  throw new Error("El demo no quedó listo dentro del tiempo esperado.");
}

function demoReady(report) {
  return (
    report.admin.ok &&
    report.desktop.ok &&
    report.livekit.ok &&
    report.ai.ok &&
    report.ai.demoReady
  );
}

function printServiceReport(report) {
  console.log("Estado:");
  console.log(`- Admin/API: ${report.admin.ok ? "ok" : report.admin.message}`);
  console.log(
    `- Desktop: ${report.desktop.ok ? "ok" : report.desktop.message}`,
  );
  console.log(
    `- LiveKit: ${report.livekit.ok ? "ok" : report.livekit.message}`,
  );
  console.log(
    `- IA local: ${
      report.ai.ok
        ? report.ai.demoReady
          ? `demo (${report.ai.data?.mode})`
          : `online sin demo (${report.ai.data?.mode ?? "modo desconocido"})`
        : report.ai.message
    }`,
  );
  console.log("");
}

function resolveDemoLiveKitUrl() {
  const explicit = env.SHAPE_DEMO_LIVEKIT_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");

  if (usesLocalComposeAdmin()) {
    const runningUrl = runningComposeServiceEnv("shape-admin", "LIVEKIT_URL");
    if (runningUrl) return runningUrl.replace(/\/$/, "");
    if (composeEnv.LIVEKIT_URL)
      return composeEnv.LIVEKIT_URL.replace(/\/$/, "");
  }

  return (env.LIVEKIT_URL ?? "ws://localhost:17883").replace(/\/$/, "");
}

async function inspectHttp(url) {
  try {
    const response = await fetch(url);
    return {
      ok: response.ok,
      status: response.status,
      message: response.ok ? "ok" : `HTTP ${response.status}`,
      data: null,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      message: error instanceof Error ? error.message : String(error),
      data: null,
    };
  }
}

async function inspectJson(url, predicate) {
  try {
    const response = await fetch(url);
    const text = await response.text();
    let data = {};

    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      return {
        ok: false,
        status: response.status,
        message: `Respuesta no JSON: ${text.slice(0, 120)}`,
        data: null,
      };
    }

    return {
      ok: response.ok && predicate(data),
      status: response.status,
      message: response.ok ? "ok" : `HTTP ${response.status}`,
      data,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      message: error instanceof Error ? error.message : String(error),
      data: null,
    };
  }
}

function liveKitHttpUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "ws:") parsed.protocol = "http:";
    if (parsed.protocol === "wss:") parsed.protocol = "https:";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "http://localhost:17883";
  }
}

function adminDemoRecreateReason() {
  if (!usesLocalComposeAdmin()) return false;

  const expectedUrl = normalizeUrl(composeEnv.LIVEKIT_URL);
  if (!expectedUrl) return false;

  const currentUrl = normalizeUrl(
    runningComposeServiceEnv("shape-admin", "LIVEKIT_URL"),
  );
  if (!currentUrl) return false;

  if (currentUrl !== expectedUrl) {
    return `Admin local emite LIVEKIT_URL=${currentUrl}; se requiere ${expectedUrl}`;
  }

  return false;
}

function liveKitDemoRecreateReason() {
  if (!isFullComposeLiveKitUrl(liveKitUrl)) return false;
  if (!isLocalLiveKit(liveKitUrl)) return false;

  const expectedNodeIp = composeEnv.LIVEKIT_NODE_IP;
  if (!expectedNodeIp || isLoopbackAddress(expectedNodeIp)) return false;

  const currentConfig = runningLiveKitConfig();
  if (!currentConfig) return false;

  const currentNodeIp = currentConfig.match(/node_ip:\s*([^\s]+)/)?.[1] ?? "";
  if (currentNodeIp !== expectedNodeIp) {
    return `LiveKit local anuncia node_ip=${currentNodeIp || "sin configurar"}; se requiere LIVEKIT_NODE_IP=${expectedNodeIp}`;
  }

  const currentTurnHost = currentConfig.match(/host:\s*([^\s]+)/)?.[1] ?? "";
  const expectedTurnHost = composeEnv.LIVEKIT_TURN_DOMAIN;
  if (currentTurnHost !== expectedTurnHost) {
    return `LiveKit local anuncia TURN=${currentTurnHost || "sin configurar"}; se requiere LIVEKIT_TURN_DOMAIN=${expectedTurnHost}`;
  }

  return false;
}

function runningLiveKitConfig() {
  return runningComposeServiceEnv("shape-livekit", "LIVEKIT_CONFIG");
}

function runningComposeServiceEnv(service, key) {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "-p",
      "shape-meet-local",
      "-f",
      "infra/docker-compose.coolify.yml",
      "exec",
      "-T",
      service,
      "printenv",
      key,
    ],
    {
      cwd: process.cwd(),
      env: composeEnv,
      encoding: "utf8",
    },
  );

  if (result.status !== 0 || !result.stdout.trim()) return null;
  return result.stdout.trim();
}

function runDockerCompose() {
  console.log(
    "> docker compose -p shape-meet-local -f infra/docker-compose.coolify.yml up -d --build",
  );
  const result = spawnSync(
    "docker",
    [
      "compose",
      "-p",
      "shape-meet-local",
      "-f",
      "infra/docker-compose.coolify.yml",
      "up",
      "-d",
      "--build",
    ],
    {
      cwd: process.cwd(),
      env: composeEnv,
      encoding: "utf8",
      stdio: "inherit",
    },
  );

  if (result.status !== 0) {
    throw new Error("No se pudo levantar Docker Compose para el demo.");
  }
}

function recreateLiveKitCompose() {
  console.log(
    "> docker compose -p shape-meet-local -f infra/docker-compose.coolify.yml up -d --force-recreate shape-livekit",
  );
  const result = spawnSync(
    "docker",
    [
      "compose",
      "-p",
      "shape-meet-local",
      "-f",
      "infra/docker-compose.coolify.yml",
      "up",
      "-d",
      "--force-recreate",
      "shape-livekit",
    ],
    {
      cwd: process.cwd(),
      env: composeEnv,
      encoding: "utf8",
      stdio: "inherit",
    },
  );

  if (result.status !== 0) {
    throw new Error("No se pudo recrear LiveKit para el demo.");
  }
}

function recreateAdminCompose() {
  console.log(
    "> docker compose -p shape-meet-local -f infra/docker-compose.coolify.yml up -d --force-recreate shape-admin",
  );
  const result = spawnSync(
    "docker",
    [
      "compose",
      "-p",
      "shape-meet-local",
      "-f",
      "infra/docker-compose.coolify.yml",
      "up",
      "-d",
      "--force-recreate",
      "shape-admin",
    ],
    {
      cwd: process.cwd(),
      env: composeEnv,
      encoding: "utf8",
      stdio: "inherit",
    },
  );

  if (result.status !== 0) {
    throw new Error("No se pudo recrear el admin para el demo.");
  }
}

function runLiveKitDevCompose() {
  const target = serviceTarget(liveKitUrl);
  const httpPort = target.port || 17880;
  const devEnv = {
    ...composeEnv,
    LIVEKIT_DEV_HTTP_PORT: String(httpPort),
    LIVEKIT_DEV_RTC_TCP_PORT:
      composeEnv.LIVEKIT_DEV_RTC_TCP_PORT ?? String(httpPort + 1),
    LIVEKIT_DEV_RTC_UDP_PORT:
      composeEnv.LIVEKIT_DEV_RTC_UDP_PORT ?? String(httpPort + 2),
  };

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
      env: devEnv,
      encoding: "utf8",
      stdio: "inherit",
    },
  );

  if (result.status !== 0) {
    throw new Error("No se pudo levantar LiveKit dev para el demo.");
  }
}

function startProcess(label, pnpmArgs) {
  console.log(`> pnpm ${pnpmArgs.join(" ")}`);
  const child = spawn(pnpmCommand(), pnpmArgs, {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
  });
  children.push({ label, child });
  child.on("exit", (code, signal) => {
    if (signal) return;
    if (code && code !== 0) {
      console.error(`${label} terminó con código ${code}.`);
    }
  });
}

function runPnpmCapture(pnpmArgs) {
  console.log("");
  console.log(`> pnpm ${pnpmArgs.join(" ")}`);
  const result = spawnSync(pnpmCommand(), pnpmArgs, {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(
      `pnpm ${pnpmArgs.join(" ")} falló con código ${result.status}.`,
    );
  }

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

async function replaceExistingAiSidecar() {
  const target = serviceTarget(aiUrl);
  const listeners = findListeningProcesses(target.port);

  if (listeners.length === 0) {
    console.log(
      `No encontré un proceso escuchando en el puerto IA ${target.port}; arrancaré el demo.`,
    );
    return;
  }

  const inspected = listeners.map((listener) => ({
    ...listener,
    ...inspectProcess(listener.pid),
  }));
  const safeTargets = inspected.filter(isShapeMeetAiSidecarProcess);

  if (safeTargets.length === 0) {
    const detail = inspected
      .map(
        (processInfo) =>
          `PID ${processInfo.pid}: ${processInfo.commandLine || "sin comando visible"}`,
      )
      .join("\n");
    throw new Error(
      [
        `El puerto IA ${target.port} está ocupado, pero no parece ser un sidecar de Shape Meet.`,
        "No lo voy a detener automáticamente.",
        detail,
      ].join("\n"),
    );
  }

  for (const processInfo of safeTargets) {
    console.log(
      `> reemplazando sidecar IA local PID ${processInfo.pid}: ${processInfo.commandLine}`,
    );
    terminateProcess(processInfo.pid);
  }

  await waitForListenersToClose(target.port, safeTargets);
}

function serviceTarget(rawUrl) {
  const parsed = new URL(rawUrl);
  const port = Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80);
  return { host: parsed.hostname, port };
}

function findListeningProcesses(port) {
  if (process.platform === "win32") return findWindowsListeners(port);
  return findUnixListeners(port);
}

function findUnixListeners(port) {
  const result = spawnSync(
    "lsof",
    ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
    {
      encoding: "utf8",
    },
  );

  if (result.status !== 0 || !result.stdout.trim()) return [];

  return [...new Set(result.stdout.split(/\s+/).filter(Boolean))]
    .map((pid) => Number(pid))
    .filter(Number.isInteger)
    .map((pid) => ({ pid }));
}

function findWindowsListeners(port) {
  const result = spawnSync("netstat", ["-ano", "-p", "tcp"], {
    encoding: "utf8",
  });

  if (result.status !== 0 || !result.stdout.trim()) return [];

  const listeners = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[0].toUpperCase() !== "TCP") continue;
    const [localAddress, state, pid] = [parts[1], parts[3], parts[4]];
    if (state.toUpperCase() !== "LISTENING") continue;
    if (!localAddress.endsWith(`:${port}`)) continue;
    const numericPid = Number(pid);
    if (Number.isInteger(numericPid)) listeners.push({ pid: numericPid });
  }

  return [
    ...new Map(listeners.map((listener) => [listener.pid, listener])).values(),
  ];
}

function inspectProcess(pid) {
  if (process.platform === "win32") return inspectWindowsProcess(pid);
  return inspectUnixProcess(pid);
}

function inspectUnixProcess(pid) {
  const result = spawnSync(
    "ps",
    ["-p", String(pid), "-o", "pid=", "-o", "command="],
    {
      encoding: "utf8",
    },
  );

  return {
    commandLine: result.stdout.trim().replace(/^\d+\s+/, ""),
  };
}

function inspectWindowsProcess(pid) {
  const command = [
    '$p = Get-CimInstance Win32_Process -Filter "ProcessId = ' +
      Number(pid) +
      '";',
    "if ($p) {",
    "$p | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress",
    "}",
  ].join(" ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    {
      encoding: "utf8",
    },
  );

  try {
    const payload = JSON.parse(result.stdout.trim());
    return {
      commandLine:
        payload.CommandLine || payload.ExecutablePath || `Proceso ${pid}`,
    };
  } catch {
    return { commandLine: `Proceso ${pid}` };
  }
}

function isShapeMeetAiSidecarProcess(processInfo) {
  const commandLine = (processInfo.commandLine ?? "")
    .replaceAll("\\", "/")
    .toLowerCase();

  return (
    commandLine.includes("apps/ai-sidecar/server.py") ||
    commandLine.includes("shape-ai-sidecar") ||
    (commandLine.includes("shape-meet") && commandLine.includes("ai-sidecar"))
  );
}

function terminateProcess(pid) {
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(`No pude detener el sidecar IA PID ${pid}.`);
    }
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function waitForListenersToClose(port, expectedProcesses) {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const listeners = findListeningProcesses(port);
    const expectedPids = new Set(expectedProcesses.map((item) => item.pid));
    const stillExpected = listeners.some((listener) =>
      expectedPids.has(listener.pid),
    );
    if (!stillExpected) return;
    await sleep(250);
  }

  if (process.platform !== "win32") {
    for (const processInfo of expectedProcesses) {
      try {
        process.kill(processInfo.pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
  }

  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const listeners = findListeningProcesses(port);
    const expectedPids = new Set(expectedProcesses.map((item) => item.pid));
    const stillExpected = listeners.some((listener) =>
      expectedPids.has(listener.pid),
    );
    if (!stillExpected) return;
    await sleep(250);
  }

  throw new Error("No pude liberar el puerto IA para arrancar el demo.");
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

function resolveLocalComposeEnv(values) {
  const resolved = { ...values };

  if (resolved.SHAPE_DEMO_LIVEKIT_URL) {
    resolved.LIVEKIT_URL = resolved.SHAPE_DEMO_LIVEKIT_URL;
  }

  if (
    isLocalLiveKit(resolved.LIVEKIT_URL) &&
    String(resolved.LIVEKIT_USE_EXTERNAL_IP ?? "false").toLowerCase() ===
      "false" &&
    isLoopbackAddress(resolved.LIVEKIT_NODE_IP)
  ) {
    const lanIp = detectLanIp();
    if (lanIp) {
      resolved.LIVEKIT_NODE_IP = lanIp;
    }
  }

  if (
    isLocalLiveKit(resolved.LIVEKIT_URL) &&
    !isLocalTurnDomain(resolved.LIVEKIT_TURN_DOMAIN)
  ) {
    resolved.LIVEKIT_TURN_DOMAIN = "127.0.0.1";
  }

  return resolved;
}

function usesLocalComposeAdmin() {
  const expectedPort = String(composeEnv.ADMIN_HTTP_PORT ?? "13000");

  try {
    const parsed = new URL(adminUrl);
    return (
      ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) &&
      (parsed.port || (parsed.protocol === "https:" ? "443" : "80")) ===
        expectedPort
    );
  } catch {
    return false;
  }
}

function isFullComposeLiveKitUrl(url) {
  const expected = normalizeUrl(fullComposeLiveKitUrl());
  const current = normalizeUrl(url);
  return Boolean(expected && current && expected === current);
}

function fullComposeLiveKitUrl() {
  const port = String(composeEnv.LIVEKIT_HTTP_PORT ?? "7880");

  try {
    const parsed = new URL(
      infraEnv.LIVEKIT_URL ?? rootEnv.LIVEKIT_URL ?? "ws://localhost:7880",
    );
    if (isLocalLiveKit(parsed.toString())) {
      parsed.protocol = parsed.protocol === "wss:" ? "wss:" : "ws:";
      parsed.hostname = "localhost";
      parsed.port = port;
      parsed.pathname = "";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString().replace(/\/$/, "");
    }
  } catch {
    // Fall through to local default below.
  }

  return `ws://localhost:${port}`;
}

function normalizeUrl(value) {
  if (!value) return null;

  try {
    const parsed = new URL(String(value).trim());
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return String(value).trim().replace(/\/$/, "") || null;
  }
}

function isLocalLiveKit(url) {
  try {
    const parsed = new URL(url ?? "");
    return ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function isLoopbackAddress(value) {
  const address = String(value ?? "").trim();
  return !address || ["127.0.0.1", "localhost", "::1"].includes(address);
}

function isLocalTurnDomain(value) {
  const domain = String(value ?? "")
    .trim()
    .toLowerCase();
  return ["127.0.0.1", "localhost", "::1"].includes(domain);
}

function detectLanIp() {
  if (process.platform === "darwin") {
    return firstCommandLine("sh", [
      "-lc",
      "ipconfig getifaddr \"$(route get default | awk '/interface:/ {print $2}')\"",
    ]);
  }

  if (process.platform === "win32") {
    return firstCommandLine("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      [
        "$ip = Get-NetIPConfiguration |",
        "Where-Object { $_.IPv4DefaultGateway -and $_.IPv4Address } |",
        "Select-Object -First 1 -ExpandProperty IPv4Address |",
        "Select-Object -ExpandProperty IPAddress;",
        "if ($ip) { $ip }",
      ].join(" "),
    ]);
  }

  return firstCommandLine("sh", [
    "-lc",
    "hostname -I 2>/dev/null | awk '{print $1}'",
  ]);
}

function firstCommandLine(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8" });
  if (result.status !== 0) return null;
  const line = result.stdout.trim().split(/\r?\n/)[0]?.trim();
  return line && /^\d{1,3}(\.\d{1,3}){3}$/.test(line) ? line : null;
}

async function waitForExitSignal() {
  await new Promise((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });

  await stopStartedProcesses();
}

async function stopStartedProcesses() {
  for (const { child } of children) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }

  await Promise.all(
    children.map(
      ({ child }) =>
        new Promise((resolve) => {
          if (child.exitCode !== null) {
            resolve();
            return;
          }

          const timeout = setTimeout(() => {
            if (child.exitCode === null) child.kill("SIGKILL");
            resolve();
          }, 5000);

          child.once("exit", () => {
            clearTimeout(timeout);
            resolve();
          });
        }),
    ),
  );
}

function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
