import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const skipSentry = args.includes("--skip-sentry");
const skipAiContract = args.includes("--skip-ai-contract");
const skipAiAdapters = args.includes("--skip-ai-adapters");
const skipAiDemo = skipAiAdapters || args.includes("--skip-ai-demo");
const skipAiRuntime = skipAiAdapters || args.includes("--skip-ai-runtime");
const skipAiManaged = skipAiAdapters || args.includes("--skip-ai-managed");
const skipAiCommand = skipAiAdapters || args.includes("--skip-ai-command");
const apiUrl = (
  envOrFile(
    "SHAPE_DEMO_API_URL",
    "apps/desktop/.env.local",
    "VITE_SHAPE_API_URL",
  ) ?? "http://localhost:13000"
).replace(/\/$/, "");
const aiUrl = (
  envOrFile(
    "SHAPE_DEMO_AI_URL",
    "apps/desktop/.env.local",
    "VITE_SHAPE_AI_SERVICE_URL",
  ) ?? "http://127.0.0.1:7851"
).replace(/\/$/, "");

await main();

async function main() {
  await assertJsonHealth(
    "admin/API",
    `${apiUrl}/api/health`,
    (data) => data.ok === true && data.database === "ok",
  );
  await assertJsonHealth(
    "AI sidecar",
    `${aiUrl}/health`,
    (data) => data.status === "ready",
  );

  if (!skipSentry) {
    runPnpm("check:sentry");
  }

  runPnpm("demo:prepare");
  runPnpm("smoke:meeting-flow", {
    SHAPE_SMOKE_API_URL: apiUrl,
  });

  if (!skipAiContract) {
    runPnpm("smoke:ai-contract");
  }
  if (!skipAiDemo) {
    runPnpm("smoke:ai-demo");
  }
  if (!skipAiRuntime) {
    runPnpm("smoke:ai-runtime");
    runPnpm("smoke:ai-model-runtime");
    runPnpm("smoke:ai-model-wrappers");
    runPnpm("smoke:ai-demo-sidecar");
  }
  if (!skipAiManaged) {
    runPnpm("smoke:ai-managed");
  }
  if (!skipAiCommand) {
    runPnpm("smoke:ai-command");
    runPnpm("smoke:ai-stage-command");
  }

  runPnpm("demo:prepare");
  console.log("");
  console.log("Local demo check ok");
}

async function assertJsonHealth(label, url, predicate) {
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    fail(
      `${label} is not reachable at ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const text = await response.text();
  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    fail(
      `${label} returned non-JSON response from ${url}: ${text.slice(0, 300)}`,
    );
  }

  if (!response.ok || !predicate(data)) {
    fail(
      `${label} health failed at ${url}: HTTP ${response.status}\n${JSON.stringify(data, null, 2)}`,
    );
  }

  console.log(`${label} health ok`);
}

function runPnpm(script, extraEnv = {}) {
  console.log("");
  console.log(`> pnpm ${script}`);
  const result = spawnSync(pnpmCommand(), [script], {
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv },
    stdio: "inherit",
  });

  if (result.error) {
    fail(`pnpm ${script} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`pnpm ${script} exited with ${result.status}`);
  }
}

function envOrFile(envKey, file, fileKey) {
  return process.env[envKey]?.trim() || readEnvFileValue(file, fileKey);
}

function readEnvFileValue(file, key) {
  if (!existsSync(file)) return null;

  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;
    const currentKey = line.slice(0, equalsIndex).trim();
    if (currentKey !== key) continue;
    let value = line.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }

  return null;
}

function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
