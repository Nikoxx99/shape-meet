import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const args = new Set(process.argv.slice(2));
const doctorOnly = args.has("--doctor");
const noDocker = args.has("--no-docker");
const noPrepare = args.has("--no-prepare");
const strict = args.has("--strict");
const verifyUi = args.has("--verify-ui");
const env = {
  ...process.env,
  ...readEnvFile("infra/env.local.example"),
  ...readEnvFile(".env.local"),
  ...readEnvFile("apps/admin/.env.local"),
  ...readEnvFile("apps/desktop/.env.local"),
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
  console.log("");

  const initial = await inspectServices();
  printServiceReport(initial);

  if (doctorOnly) {
    if (strict && !demoReady(initial)) process.exit(1);
    return;
  }

  if (!initial.admin.ok && !noDocker) {
    runDockerCompose();
  }

  if (initial.ai.ok && !initial.ai.demoReady) {
    throw new Error(
      "IA local ya está activa pero no en modo demo visible. Detén ese proceso y vuelve a correr `pnpm demo:up`, o inicia manualmente `pnpm dev:ai:demo`.",
    );
  }

  if (!initial.ai.ok) {
    startProcess("IA demo", ["dev:ai:demo"]);
  }

  if (!initial.desktop.ok) {
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

  console.log("");
  console.log(
    "Demo activo. Ctrl+C detiene los procesos locales iniciados por este comando.",
  );
  await waitForExitSignal();
}

async function inspectServices() {
  const [admin, desktop, ai] = await Promise.all([
    inspectJson(
      `${adminUrl}/api/health`,
      (data) => data.ok === true && data.database === "ok",
    ),
    inspectHttp(appUrl),
    inspectJson(`${aiUrl}/health`, (data) => data.status === "ready"),
  ]);
  const demoReady =
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
    report.admin.ok && report.desktop.ok && report.ai.ok && report.ai.demoReady
  );
}

function printServiceReport(report) {
  console.log("Estado:");
  console.log(`- Admin/API: ${report.admin.ok ? "ok" : report.admin.message}`);
  console.log(
    `- Desktop: ${report.desktop.ok ? "ok" : report.desktop.message}`,
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
      env,
      encoding: "utf8",
      stdio: "inherit",
    },
  );

  if (result.status !== 0) {
    throw new Error("No se pudo levantar Docker Compose para el demo.");
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

async function waitForExitSignal() {
  await new Promise((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });

  for (const { child } of children) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
}

function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
