// smoke:ai-voice-vcclient2-live
// Exercises the in-process voice engine against a LIVE VCClient v2 server
// (w-okada 2.x). Unlike smoke:ai-voice-inproc (which uses a mock), this drives
// real conversions and reports measured latency.
//
// It runs ONLY when a VCClient v2 server is reachable:
//   * endpoint = VCCLIENT000_HTTP_ENDPOINT (or default 127.0.0.1:18000)
//   * GET /api/hello must answer as VCClient/w-okada; otherwise -> skipped (0).
//
// What it validates against the live server:
//   * auto-detect resolves to v2 and the voice stage reports mode=vcclient2;
//   * >=10 real conversions of 200 ms Float32 chunks: output != input, output
//     length coherent, per-chunk x-performance latency surfaced;
//   * p50 latency reported in the output;
//   * idempotent identity bootstrap: given the active slot's model name, the
//     slot is detected (no re-upload), index_ratio is sanitised to 0.0, and it
//     stays the active slot -> the voice stage never fails.

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

const skip = makeSkip("vcclient2 live smoke");
const python = resolveEndpointPython();

const CHUNK_COUNT = 12; // >= 10 warm conversions
const SAMPLE_RATE = 48000;
const CHUNK_SECONDS = 0.2;

const base = normalizeBase(
  process.env.VCCLIENT000_HTTP_ENDPOINT || "http://127.0.0.1:18000",
);

let endpoint = null;
try {
  if (!(await pythonCanImport(python, ["json", "sys"]))) {
    skip(`endpoint python no disponible (${python}).`);
  }

  // Gate: a live VCClient v2 server must be answering /api/hello.
  const hello = await tryJson(`${base}/api/hello`);
  if (!hello.ok) {
    skip(`VCClient v2 no responde en ${base}/api/hello (${hello.error}).`);
  }
  const helloText = JSON.stringify(hello.data || {}).toLowerCase();
  if (!/vcclient|w-okada|cute voice/.test(helloText)) {
    skip(`${base}/api/hello no parece VCClient (${helloText.slice(0, 80)}).`);
  }

  // Discover the active identity slot so the bootstrap runs its idempotent
  // detect-by-name path (no 200 MB upload inside a smoke).
  const config = await tryJson(
    `${base}/api/configuration-manager/configuration`,
  );
  const slots = await tryJson(`${base}/api/slot-manager/slots`);
  const identity = pickIdentity(
    slots.ok ? slots.data : [],
    config.ok ? config.data?.current_slot_index : undefined,
  );
  if (!identity) {
    skip(`ningún slot RVC utilizable en ${base} para ejercer el bootstrap.`);
  }
  console.log(
    `live server: slot="${identity.name}" (index ${identity.slotIndex}), model_file="${identity.model_file}"`,
  );

  const endpointPort = await getFreePort();
  endpoint = spawnModelEndpoint(python, endpointPort, {
    SHAPE_MODEL_ENDPOINT_ENGINE: "inproc",
    VCCLIENT000_HTTP_ENDPOINT: base,
    SHAPE_VOICE_ENDPOINT_TIMEOUT_SECS: "20",
  });
  const output = captureOutput(endpoint);
  await waitForHttpUp(endpoint, endpointPort, "/health", output);

  const chunk = makeF32Chunk(SAMPLE_RATE, CHUNK_SECONDS);
  const chunkBase64 = chunk.toString("base64");
  const identityPayload = {
    voiceModelPath: `/virtual/${identity.model_file}`,
    ...(identity.index_file
      ? { voiceIndexPath: `/virtual/${identity.index_file}` }
      : {}),
  };

  const serverLatencies = [];
  const roundTripLatencies = [];
  for (let sequence = 1; sequence <= CHUNK_COUNT; sequence += 1) {
    const result = await postAudio(
      endpointPort,
      chunkBase64,
      sequence,
      identityPayload,
    );
    const stage = (result.audio?.stages ?? []).find((s) => s.id === "voice");
    assert(stage, `chunk ${sequence}: no voice stage in response`);
    assert(
      stage.changed === true,
      `chunk ${sequence}: not converted (reason=${stage.reason} detail=${stage.detail})`,
    );
    assert(
      stage.mode === "vcclient2",
      `chunk ${sequence}: mode=${stage.mode}, expected vcclient2`,
    );

    const outBuf = Buffer.from(
      result.audio?.audio?.audioDataBase64 ?? "",
      "base64",
    );
    assert(
      outBuf.length % 4 === 0,
      `chunk ${sequence}: output not f32-aligned (${outBuf.length})`,
    );
    // First chunk may be shorter while the pipeline fills; warm chunks match exactly.
    if (sequence <= 2) {
      assert(
        outBuf.length > 0 && outBuf.length <= chunk.length,
        `chunk ${sequence}: incoherent output length ${outBuf.length} (in ${chunk.length})`,
      );
    } else {
      assert(
        outBuf.length === chunk.length,
        `chunk ${sequence}: length ${outBuf.length} != input ${chunk.length}`,
      );
      assert(
        !outBuf.equals(chunk),
        `chunk ${sequence}: output equals input (no conversion)`,
      );
    }

    if (typeof stage.serverLatencyMs === "number")
      serverLatencies.push(stage.serverLatencyMs);
    if (typeof stage.latencyMs === "number")
      roundTripLatencies.push(stage.latencyMs);
  }

  // Bootstrap outcome: slot activated, index sanitised, stage healthy.
  const configAfter = await tryJson(
    `${base}/api/configuration-manager/configuration`,
  );
  assert(
    configAfter.ok &&
      Number(configAfter.data?.current_slot_index) === identity.slotIndex,
    `active slot after bootstrap is ${configAfter.data?.current_slot_index}, expected ${identity.slotIndex}`,
  );
  const slotAfter = await tryJson(
    `${base}/api/slot-manager/slots/${identity.slotIndex}`,
  );
  assert(
    slotAfter.ok && Number(slotAfter.data?.index_ratio) === 0,
    `index_ratio not sanitised to 0.0 (got ${slotAfter.data?.index_ratio})`,
  );
  const diag = await tryJson(`http://127.0.0.1:${endpointPort}/diagnostics`);
  const voiceState = diag.data?.diagnostics?.stages?.find(
    (s) => s.id === "voice",
  )?.engine;
  assert(
    voiceState && voiceState.state !== "failed",
    `voice stage failed after bootstrap: ${JSON.stringify(voiceState)}`,
  );

  const warmServer = serverLatencies.slice(2);
  const p50Server = percentile(warmServer, 50);
  const p95Server = percentile(warmServer, 95);
  const p50RoundTrip = percentile(roundTripLatencies.slice(2), 50);

  console.log(
    `vcclient2 live smoke ok: ${CHUNK_COUNT} chunks converted, mode=vcclient2, bootstrap idempotent, index_ratio=0.0`,
  );
  console.log(
    `  server latency (x-performance) p50=${p50Server}ms p95=${p95Server}ms | round-trip p50=${p50RoundTrip}ms`,
  );
  console.log(`  server latencies (ms): [${serverLatencies.join(", ")}]`);
} catch (error) {
  console.error(error?.stack || String(error));
  process.exit(1);
} finally {
  if (endpoint) endpoint.kill();
}

// --- helpers -------------------------------------------------------------------

function normalizeBase(value) {
  return String(value)
    .replace(/\/+$/, "")
    .replace(/\/(test|api\/.*)$/, "");
}

function pickIdentity(slots, activeIndex) {
  if (!Array.isArray(slots)) return null;
  const usable = slots.filter(
    (slot) =>
      slot &&
      typeof slot.name === "string" &&
      slot.name.length > 0 &&
      typeof slot.model_file === "string" &&
      slot.model_file.length > 0,
  );
  const active = usable.find(
    (slot) => Number(slot.slot_index) === Number(activeIndex),
  );
  const chosen = active || usable[0];
  if (!chosen) return null;
  return {
    slotIndex: Number(chosen.slot_index),
    name: chosen.name,
    model_file: chosen.model_file,
    index_file: chosen.index_file || null,
  };
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

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return Math.round(sorted[index] * 100) / 100;
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

async function postAudio(port, audioBase64, sequence, identity) {
  const response = await fetch(`http://127.0.0.1:${port}/process-audio`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session: { id: "vcclient2-live" },
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
