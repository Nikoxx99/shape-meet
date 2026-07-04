// smoke:ai-vcclient-managed
// Exercises the MANAGED VCClient v2 runtime: the model endpoint server
// (engine=inproc, VCCLIENT000_MANAGED=1) supervises VCClient as a child
// process — starting it, waiting for health, restarting it on death, and
// tearing it down cleanly on shutdown.
//
// Runs ONLY when a real VCClient dist is available:
//   * VCCLIENT000_DIST_DIR must point at a dir with the `main`/`main.exe` binary
//     (its model_dir/settings state lives beside it). Absent -> skipped (exit 0).
//
// Because a VCClient dist is single-tenant (two instances sharing the same
// model_dir conflict and the second dies ~30 s into boot), the smoke OWNS the
// dist: it stops any pre-existing `main cui` first so the supervisor is the sole
// owner (VCCLIENT000_PORT, default 18000).
//
// Full cycle validated:
//   1. supervisor boots VCClient and the voice stage reaches healthy;
//   2. >=3 real conversions through the whole chain (endpoint /process-audio ->
//      inproc voice engine -> managed VCClient), mode=vcclient2, output != input;
//   3. CRASH TEST: kill -9 the child process group; the supervisor detects the
//      death, re-sanitises index_ratio=0.0, relaunches, becomes healthy again;
//      while down the voice stage is `degraded`/`vcclient_starting` (NOT failed);
//      >=3 conversions work again afterwards;
//   4. clean shutdown (SIGTERM the endpoint) leaves NO orphan `main` process.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  assert,
  captureOutput,
  getFreePort,
  makeSkip,
  pythonCanImport,
  resolveEndpointPython,
  spawnModelEndpoint,
  waitForHttpUp,
} from "./support/inproc-smoke.mjs";

const skip = makeSkip("vcclient managed smoke");
const python = resolveEndpointPython();

const CHUNK_COUNT = 3;
const SAMPLE_RATE = 48000;
const CHUNK_SECONDS = 0.2;
const BOOT_TIMEOUT_SECS = Number(
  process.env.VCCLIENT000_BOOT_TIMEOUT_SECS || 120,
);
const HEALTH_DEADLINE_MS = (BOOT_TIMEOUT_SECS + 30) * 1000;

const distDir = process.env.VCCLIENT000_DIST_DIR;
const vcPort = Number(process.env.VCCLIENT000_PORT || 18000);

let endpoint = null;
const trackedPids = new Set();

try {
  if (!distDir) {
    skip(
      "VCCLIENT000_DIST_DIR no configurado (apunta al dist real de VCClient).",
    );
  }
  const binaryName = process.platform === "win32" ? "main.exe" : "main";
  const binaryPath = join(distDir, binaryName);
  if (!existsSync(binaryPath)) {
    skip(`binario VCClient no encontrado: ${binaryPath}.`);
  }
  if (!(await pythonCanImport(python, ["json", "sys"]))) {
    skip(`endpoint python no disponible (${python}).`);
  }

  // Own the dist: stop any pre-existing VCClient so the supervisor is the sole
  // owner (two instances sharing model_dir conflict). Best-effort.
  stopPreexistingVcClient();
  await waitForPortFree(vcPort, 8000);

  const endpointPort = await getFreePort();
  endpoint = spawnModelEndpoint(python, endpointPort, {
    SHAPE_MODEL_ENDPOINT_ENGINE: "inproc",
    VCCLIENT000_MANAGED: "1",
    VCCLIENT000_DIST_DIR: distDir,
    VCCLIENT000_PORT: String(vcPort),
    VCCLIENT000_BOOT_TIMEOUT_SECS: String(BOOT_TIMEOUT_SECS),
    SHAPE_VOICE_ENDPOINT_TIMEOUT_SECS: "20",
  });
  const output = captureOutput(endpoint);
  await waitForHttpUp(endpoint, endpointPort, "/health", output);

  // --- 1. supervisor boots VCClient -> healthy -------------------------------
  console.log(
    `waiting for managed VCClient boot (<= ${BOOT_TIMEOUT_SECS + 30}s)...`,
  );
  let sawStarting = false;
  const boot = await waitForVoiceRuntime(
    endpointPort,
    (rt) => {
      if (rt && ["starting", "idle", "restarting"].includes(rt.state))
        sawStarting = true;
      return rt && rt.state === "healthy" && rt.running && rt.pid;
    },
    HEALTH_DEADLINE_MS,
    output,
  );
  assert(boot.ok, `VCClient no llegó a healthy: ${JSON.stringify(boot.last)}`);
  const bootPid = boot.value.pid;
  trackedPids.add(bootPid);
  assert(boot.value.managed === true, "voiceRuntime.managed debería ser true");
  assert(
    sawStarting || boot.value.state === "healthy",
    "nunca se observó el estado de arranque del supervisor",
  );
  console.log(
    `boot ok: pid=${bootPid} endpoint=${boot.value.endpoint} restarts=${boot.value.restarts}`,
  );

  const identity = await discoverIdentity(vcPort);
  const chunk = makeF32Chunk(SAMPLE_RATE, CHUNK_SECONDS);
  const chunkBase64 = chunk.toString("base64");

  // --- 2. real conversions through the whole chain ---------------------------
  await convertChunks(endpointPort, chunkBase64, chunk, identity, "pre-crash");

  // --- 3. CRASH TEST ---------------------------------------------------------
  const before = await voiceRuntime(endpointPort);
  console.log(
    `=== CRASH: kill -9 process group of pid ${bootPid} (restarts=${before.restarts}) ===`,
  );
  killProcessGroup(bootPid);

  // 3a. supervisor must DETECT the death (leave healthy) and record lastCrash.
  const down = await waitForVoiceRuntime(
    endpointPort,
    (rt) => rt && rt.state !== "healthy",
    15000,
    output,
  );
  assert(
    down.ok,
    `el supervisor no detectó la muerte del hijo: ${JSON.stringify(down.last)}`,
  );
  assert(
    ["restarting", "starting", "idle"].includes(down.value.state),
    `estado inesperado tras el crash: ${down.value.state}`,
  );
  assert(down.value.lastCrash, "lastCrash no registrado tras el crash");
  console.log(
    `crash detected: state=${down.value.state} lastCrash=${JSON.stringify(down.value.lastCrash)}`,
  );

  // 3b. while down, the voice stage is degraded/vcclient_starting (NOT failed).
  const downStage = await postAudio(endpointPort, chunkBase64, 99, identity);
  const downVoice = (downStage.audio?.stages ?? []).find(
    (s) => s.id === "voice",
  );
  assert(downVoice, "sin stage voice mientras VCClient arranca");
  assert(
    downVoice.changed === false && downVoice.reason === "vcclient_starting",
    `mientras arranca esperaba reason=vcclient_starting, got changed=${downVoice.changed} reason=${downVoice.reason}`,
  );
  assert(
    downVoice.state !== "failed",
    `stage voice en 'failed' mientras arranca (debería ser degraded): ${JSON.stringify(downVoice)}`,
  );
  assert(
    downStage.audio?.status === "degraded",
    `estado del audio esperado 'degraded' mientras arranca, got ${downStage.audio?.status}`,
  );

  // 3c. relaunch -> healthy again with a new pid and restarts incremented.
  console.log(
    `waiting for automatic relaunch -> healthy (<= ${BOOT_TIMEOUT_SECS + 30}s)...`,
  );
  const relaunch = await waitForVoiceRuntime(
    endpointPort,
    (rt) => rt && rt.state === "healthy" && rt.running && rt.pid,
    HEALTH_DEADLINE_MS,
    output,
  );
  assert(
    relaunch.ok,
    `VCClient no se relanzó a healthy: ${JSON.stringify(relaunch.last)}`,
  );
  const newPid = relaunch.value.pid;
  trackedPids.add(newPid);
  assert(
    relaunch.value.restarts >= 1,
    `restarts no incrementó tras el crash (got ${relaunch.value.restarts})`,
  );
  assert(
    newPid !== bootPid,
    `el pid no cambió tras el relanzamiento (${newPid})`,
  );
  console.log(
    `relaunch ok: newPid=${newPid} (was ${bootPid}) restarts=${relaunch.value.restarts}`,
  );

  // 3d. params.json re-sanitised: index_ratio == 0.0 in every slot.
  const ratios = readIndexRatios(distDir);
  assert(ratios.length > 0, "no se encontraron params.json en model_dir");
  assert(
    ratios.every((r) => Number(r) === 0),
    `index_ratio no saneado a 0.0 tras el relanzamiento: ${JSON.stringify(ratios)}`,
  );
  console.log(
    `index_ratio saneado en ${ratios.length} slot(s): ${JSON.stringify(ratios)}`,
  );

  // 3e. conversions work again.
  await convertChunks(endpointPort, chunkBase64, chunk, identity, "post-crash");

  // --- 4. clean shutdown, no orphans -----------------------------------------
  console.log("=== SHUTDOWN: SIGTERM endpoint server ===");
  endpoint.kill("SIGTERM");
  const exited = await waitForExit(endpoint, 15000);
  assert(exited, "el endpoint server no terminó tras SIGTERM");

  await sleep(1500);
  const orphanPids = [...trackedPids].filter((pid) => pidAlive(pid));
  assert(
    orphanPids.length === 0,
    `procesos VCClient huérfanos tras el apagado: pids=${orphanPids.join(", ")}`,
  );
  const orphanByCmd = pgrepVcClient(vcPort);
  assert(
    orphanByCmd.length === 0,
    `procesos 'main cui' huérfanos en puerto ${vcPort}: pids=${orphanByCmd.join(", ")}`,
  );
  endpoint = null;

  console.log(
    `vcclient managed smoke ok: boot -> ${CHUNK_COUNT} conversions -> crash+relaunch -> ${CHUNK_COUNT} conversions -> clean shutdown (no orphans).`,
  );
} catch (error) {
  console.error(error?.stack || String(error));
  process.exit(1);
} finally {
  if (endpoint) {
    try {
      endpoint.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    // Last-resort cleanup so a failed run never leaves a managed child behind.
    stopPreexistingVcClient();
  }
}

// --- helpers -------------------------------------------------------------------

async function convertChunks(port, chunkBase64, chunk, identity, label) {
  console.log(`--- ${CHUNK_COUNT} conversions (${label}) ---`);
  for (let sequence = 1; sequence <= CHUNK_COUNT; sequence += 1) {
    const result = await postAudio(port, chunkBase64, sequence, identity);
    const stage = (result.audio?.stages ?? []).find((s) => s.id === "voice");
    assert(stage, `${label} chunk ${sequence}: sin stage voice`);
    assert(
      stage.changed === true,
      `${label} chunk ${sequence}: no convertido (reason=${stage.reason} detail=${stage.detail})`,
    );
    assert(
      stage.mode === "vcclient2",
      `${label} chunk ${sequence}: mode=${stage.mode}, esperaba vcclient2`,
    );
    const outBuf = Buffer.from(
      result.audio?.audio?.audioDataBase64 ?? "",
      "base64",
    );
    assert(
      outBuf.length % 4 === 0,
      `${label} chunk ${sequence}: salida no alineada a f32 (${outBuf.length})`,
    );
    // The first chunk after a (re)boot warms the pipeline (shorter / equal);
    // warm chunks must match length and differ from the input (real conversion).
    if (sequence > 1) {
      assert(
        outBuf.length === chunk.length,
        `${label} chunk ${sequence}: longitud ${outBuf.length} != entrada ${chunk.length}`,
      );
      assert(
        !outBuf.equals(chunk),
        `${label} chunk ${sequence}: salida == entrada (sin conversión)`,
      );
    }
    console.log(
      `  ${label} chunk ${sequence}: changed=true mode=${stage.mode} serverMs=${stage.serverLatencyMs} len=${outBuf.length}`,
    );
  }
}

async function voiceRuntime(port) {
  const diag = await tryJson(`http://127.0.0.1:${port}/diagnostics`);
  return diag.ok ? (diag.data?.diagnostics?.voiceRuntime ?? null) : null;
}

async function waitForVoiceRuntime(port, predicate, deadlineMs, output) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < deadlineMs) {
    if (endpoint && endpoint.exitCode !== null) {
      throw new Error(
        `endpoint terminó antes de tiempo (${endpoint.exitCode})\n${output?.stdout}\n${output?.stderr}`,
      );
    }
    const rt = await voiceRuntime(port);
    last = rt;
    if (predicate(rt)) return { ok: true, value: rt, last: rt };
    await sleep(750);
  }
  return { ok: false, value: last, last };
}

async function discoverIdentity(port) {
  const slots = await tryJson(
    `http://127.0.0.1:${port}/api/slot-manager/slots`,
  );
  const config = await tryJson(
    `http://127.0.0.1:${port}/api/configuration-manager/configuration`,
  );
  if (!slots.ok || !Array.isArray(slots.data)) return {};
  const usable = slots.data.filter(
    (s) =>
      s &&
      typeof s.name === "string" &&
      s.name &&
      typeof s.model_file === "string" &&
      s.model_file,
  );
  const active =
    usable.find(
      (s) => Number(s.slot_index) === Number(config.data?.current_slot_index),
    ) || usable[0];
  if (!active) return {};
  console.log(`identity: slot="${active.name}" (index ${active.slot_index})`);
  return {
    voiceModelPath: `/virtual/${active.model_file}`,
    ...(active.index_file
      ? { voiceIndexPath: `/virtual/${active.index_file}` }
      : {}),
  };
}

async function postAudio(port, audioBase64, sequence, identity) {
  const response = await fetch(`http://127.0.0.1:${port}/process-audio`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session: { id: "vcclient-managed-smoke" },
      audio: {
        sequence,
        sampleRate: SAMPLE_RATE,
        channels: 1,
        format: "pcm_f32le",
        audioDataBase64: audioBase64,
      },
      identity,
      enabled: { voice: true },
    }),
  });
  const text = await response.text();
  assert(response.ok, `/process-audio HTTP ${response.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function tryJson(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const text = await response.text();
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    return { ok: true, data: text ? JSON.parse(text) : {} };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

function makeF32Chunk(sampleRate, seconds) {
  const n = Math.floor(sampleRate * seconds);
  const buf = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i += 1) {
    buf.writeFloatLE(
      0.3 * Math.sin((2 * Math.PI * 220 * i) / sampleRate),
      i * 4,
    );
  }
  return buf;
}

function readIndexRatios(dist) {
  const modelDir = join(dist, "model_dir");
  if (!existsSync(modelDir)) return [];
  const ratios = [];
  for (const entry of readdirSync(modelDir)) {
    const paramsPath = join(modelDir, entry, "params.json");
    if (!existsSync(paramsPath)) continue;
    try {
      const data = JSON.parse(readFileSync(paramsPath, "utf-8"));
      if (data && typeof data === "object" && "index_ratio" in data)
        ratios.push(data.index_ratio);
    } catch {
      /* skip malformed */
    }
  }
  return ratios;
}

function killProcessGroup(pid) {
  // The child is a session leader (start_new_session), so -pid targets the whole
  // group (PyInstaller parent + forked worker) with a hard SIGKILL.
  try {
    process.kill(-pid, "SIGKILL");
    return;
  } catch {
    /* fall through */
  }
  try {
    // No shell: pid is a validated number; `-<pid>` targets the process group.
    execFileSync("kill", ["-9", `-${pid}`], { stdio: "ignore" });
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pgrepVcClient(port) {
  if (process.platform === "win32") return [];
  try {
    const out = execFileSync("pgrep", ["-f", `main cui.*--port ${port}`], {
      encoding: "utf-8",
    });
    return out
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
}

function stopPreexistingVcClient() {
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/IM", "main.exe", "/F", "/T"], {
        stdio: "ignore",
      });
    } catch {
      /* none running */
    }
    return;
  }
  try {
    execFileSync("pkill", ["-9", "-f", "main cui"], { stdio: "ignore" });
  } catch {
    /* none running */
  }
}

async function waitForPortFree(port, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!(await portListening(port))) return;
    await sleep(300);
  }
}

async function portListening(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/hello`, {
      signal: AbortSignal.timeout(1000),
    });
    await response.text();
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(child, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    await sleep(200);
  }
  return false;
}
