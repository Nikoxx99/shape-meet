// smoke:ai-voice-inproc
// Boots the model endpoint in inproc mode against MOCK w-okada servers and
// verifies the persistent in-process voice client for BOTH protocols:
//
//   * v1 (legacy /test): PCM -> S16 -> POST {buffer} -> {changedVoiceBase64}
//     -> S16 -> PCM round-trip, reusing the keep-alive connection.
//   * v2 (VCClient convert_chunk): raw Float32 mono is sent untouched over a
//     multipart POST and the raw Float32 body comes straight back. Auto-detect
//     picks v2 from GET /api/hello, and the x-performance latency surfaces on
//     the voice stage.
//
// Dep-free: the voice path is stdlib only, so it does not need torch/onnx/
// insightface. Skips (exit 0) only if the endpoint python is unavailable.

import { createServer as createHttpServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import {
  assert,
  captureOutput,
  fixturesDir,
  getFreePort,
  makeSkip,
  pythonCanImport,
  resolveEndpointPython,
  spawnModelEndpoint,
  waitForHttpUp,
} from "./support/inproc-smoke.mjs";

const skip = makeSkip("voice inproc smoke");
const python = resolveEndpointPython();
const chunkPath = join(fixturesDir, "chunk.pcm");

try {
  if (!(await pythonCanImport(python, ["json", "sys"]))) {
    skip(`endpoint python no disponible (${python}).`);
  }
  if (!existsSync(chunkPath)) {
    skip(`falta fixture ${chunkPath}.`);
  }
  const chunkBase64 = readFileSync(chunkPath).toString("base64");

  await runV1Phase(chunkBase64);
  await runV2Phase(chunkBase64);

  console.log(
    "voice inproc smoke ok (v1 round-trip + keep-alive, v2 f32 passthrough + x-performance)",
  );
} catch (error) {
  console.error(error?.stack || String(error));
  process.exit(1);
}

// --- v1 (legacy /test) ---------------------------------------------------------

async function runV1Phase(chunkBase64) {
  let endpoint = null;
  let mock = null;
  const counters = { connections: 0, requests: 0 };
  try {
    const mockPort = await getFreePort();
    mock = startMockV1(mockPort, counters);
    await once(mock, "listening");

    const endpointPort = await getFreePort();
    endpoint = spawnModelEndpoint(python, endpointPort, {
      SHAPE_MODEL_ENDPOINT_ENGINE: "inproc",
      VCCLIENT000_HTTP_ENDPOINT: `http://127.0.0.1:${mockPort}/test`,
      SHAPE_VOICE_ENDPOINT_TIMEOUT_SECS: "5",
    });
    const output = captureOutput(endpoint);
    await waitForHttpUp(endpoint, endpointPort, "/health", output);

    const first = await postAudio(endpointPort, chunkBase64, 1, "pcm_s16le");
    assert(
      first.audio?.status === "processed",
      `v1 chunk 1 not processed: ${first.audio?.status}`,
    );
    const stage1 = (first.audio?.stages ?? []).find((s) => s.id === "voice");
    assert(stage1?.changed === true, "v1 stage 1 did not change audio");
    assert(
      stage1?.mode === "wokada-v1",
      `expected mode wokada-v1, got ${stage1?.mode}`,
    );

    const outBase64 = first.audio?.audio?.audioDataBase64;
    assert(
      typeof outBase64 === "string" && outBase64.length > 0,
      "v1 chunk 1 returned no audio",
    );
    const inBuf = Buffer.from(chunkBase64, "base64");
    const outBuf = Buffer.from(outBase64, "base64");
    assert(
      outBuf.length === inBuf.length,
      `v1 round-trip length mismatch: in=${inBuf.length} out=${outBuf.length}`,
    );
    assert(
      !outBuf.equals(inBuf),
      "v1 output equals input (no transform applied)",
    );
    assert(
      isNegatedS16(inBuf, outBuf),
      "v1 round-trip did not preserve the mock S16 transform",
    );

    const second = await postAudio(endpointPort, chunkBase64, 2, "pcm_s16le");
    const stage2 = (second.audio?.stages ?? []).find((s) => s.id === "voice");
    assert(stage2?.changed === true, "v1 stage 2 did not change audio");
    assert(
      Number(stage2?.requestsOnConnection) >= 2,
      `expected >=2 requests on the same connection, got ${stage2?.requestsOnConnection}`,
    );
    assert(
      Number(stage2?.connectionsOpened) === 1,
      `expected exactly 1 opened connection, got ${stage2?.connectionsOpened}`,
    );
    assert(
      counters.requests >= 2,
      `mock v1 received ${counters.requests} requests`,
    );
    // The data plane reuses ONE connection (engine connectionsOpened === 1 above);
    // auto-detect adds a short-lived /api/hello probe connection, so the mock
    // TCP total is >= 1 (probe 404s, then the POSTs share a keep-alive socket).
    assert(
      counters.connections >= 1,
      `keep-alive not reused: mock v1 saw ${counters.connections} TCP connections`,
    );
  } finally {
    if (endpoint) endpoint.kill();
    if (mock) mock.close();
  }
}

// --- v2 (VCClient convert_chunk) ----------------------------------------------

async function runV2Phase(chunkBase64) {
  let endpoint = null;
  let mock = null;
  const counters = { connections: 0, convertRequests: 0 };
  try {
    // A synthetic Float32 mono chunk (200 ms @48k) for the raw-passthrough path.
    const f32Buf = makeF32Chunk(48000, 0.2);
    const f32Base64 = f32Buf.toString("base64");

    const mockPort = await getFreePort();
    mock = startMockV2(mockPort, counters);
    await once(mock, "listening");

    const endpointPort = await getFreePort();
    endpoint = spawnModelEndpoint(python, endpointPort, {
      SHAPE_MODEL_ENDPOINT_ENGINE: "inproc",
      // Base URL (no path): auto-detect must probe /api/hello and pick v2.
      VCCLIENT000_HTTP_ENDPOINT: `http://127.0.0.1:${mockPort}`,
      SHAPE_VOICE_ENDPOINT_TIMEOUT_SECS: "5",
    });
    const output = captureOutput(endpoint);
    await waitForHttpUp(endpoint, endpointPort, "/health", output);

    const first = await postAudio(endpointPort, f32Base64, 1, "pcm_f32le");
    assert(
      first.audio?.status === "processed",
      `v2 chunk 1 not processed: ${first.audio?.status}`,
    );
    const stage1 = (first.audio?.stages ?? []).find((s) => s.id === "voice");
    assert(stage1?.changed === true, "v2 stage 1 did not change audio");
    assert(
      stage1?.mode === "vcclient2",
      `expected mode vcclient2, got ${stage1?.mode}`,
    );
    assert(
      Number(stage1?.serverLatencyMs) === 50,
      `expected x-performance serverLatencyMs=50, got ${stage1?.serverLatencyMs}`,
    );

    const outBuf = Buffer.from(
      first.audio?.audio?.audioDataBase64 ?? "",
      "base64",
    );
    assert(
      outBuf.length === f32Buf.length,
      `v2 length mismatch: in=${f32Buf.length} out=${outBuf.length}`,
    );
    assert(
      !outBuf.equals(f32Buf),
      "v2 output equals input (no transform applied)",
    );
    assert(
      isNegatedF32(f32Buf, outBuf),
      "v2 round-trip did not preserve the mock f32 transform",
    );

    const second = await postAudio(endpointPort, f32Base64, 2, "pcm_f32le");
    const stage2 = (second.audio?.stages ?? []).find((s) => s.id === "voice");
    assert(stage2?.changed === true, "v2 stage 2 did not change audio");
    assert(
      Number(stage2?.requestsOnConnection) >= 2,
      `expected >=2 v2 requests on the same connection, got ${stage2?.requestsOnConnection}`,
    );
    assert(
      Number(stage2?.connectionsOpened) === 1,
      `expected exactly 1 opened v2 connection, got ${stage2?.connectionsOpened}`,
    );
    assert(
      counters.convertRequests >= 2,
      `mock v2 saw ${counters.convertRequests} convert requests`,
    );
  } finally {
    if (endpoint) endpoint.kill();
    if (mock) mock.close();
  }
}

// --- mock servers --------------------------------------------------------------

function startMockV1(port, counters) {
  const server = createHttpServer((req, res) => {
    if (req.method !== "POST" || !req.url.startsWith("/test")) {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      counters.requests += 1;
      let bufferBase64 = "";
      try {
        bufferBase64 =
          JSON.parse(Buffer.concat(chunks).toString("utf8")).buffer ?? "";
      } catch {
        bufferBase64 = "";
      }
      const transformed = negateS16(Buffer.from(bufferBase64, "base64"));
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          changedVoiceBase64: transformed.toString("base64"),
        }),
      );
    });
  });
  server.on("connection", () => {
    counters.connections += 1;
  });
  server.listen(port, "127.0.0.1");
  return server;
}

function startMockV2(port, counters) {
  const server = createHttpServer((req, res) => {
    const url = req.url.split("?", 1)[0];
    if (req.method === "GET" && url === "/api/hello") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          message: "Hello World! VCClient gives a cute voice to you!",
          credit: "w-okada",
        }),
      );
      return;
    }
    if (req.method === "PUT" && url.startsWith("/api/configuration-manager")) {
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    if (req.method === "POST" && url === "/api/voice-changer/convert_chunk") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        counters.convertRequests += 1;
        const waveform = extractWaveform(
          Buffer.concat(chunks),
          req.headers["content-type"] || "",
        );
        const transformed = negateF32(waveform);
        res
          .writeHead(200, {
            "content-type": "application/octet-stream",
            "x-performance": JSON.stringify({
              input_size: waveform.length / 4,
              output_size: transformed.length / 4,
              elapsed_time: 0.05,
              data_num: 1,
            }),
          })
          .end(transformed);
      });
      return;
    }
    res.writeHead(404).end();
  });
  server.on("connection", () => {
    counters.connections += 1;
  });
  server.listen(port, "127.0.0.1");
  return server;
}

// --- helpers -------------------------------------------------------------------

function extractWaveform(body, contentType) {
  const match = /boundary=([^;]+)/.exec(contentType);
  const boundary = match ? match[1].trim() : "";
  const headerEnd = body.indexOf("\r\n\r\n");
  if (headerEnd < 0) return Buffer.alloc(0);
  const start = headerEnd + 4;
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  let end = body.lastIndexOf(tail);
  if (end < 0) end = body.length;
  return body.subarray(start, end);
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

function negateS16(buf) {
  const out = Buffer.alloc(buf.length - (buf.length % 2));
  for (let i = 0; i + 1 < buf.length; i += 2) {
    out.writeInt16LE(Math.max(-32768, Math.min(32767, -buf.readInt16LE(i))), i);
  }
  return out;
}

function isNegatedS16(inBuf, outBuf) {
  for (let i = 0; i + 1 < inBuf.length && i + 1 < outBuf.length; i += 2) {
    const expected = Math.max(-32768, Math.min(32767, -inBuf.readInt16LE(i)));
    if (outBuf.readInt16LE(i) !== expected) return false;
  }
  return true;
}

function negateF32(buf) {
  const usable = buf.length - (buf.length % 4);
  const out = Buffer.alloc(usable);
  for (let i = 0; i + 3 < usable; i += 4) {
    out.writeFloatLE(-buf.readFloatLE(i), i);
  }
  return out;
}

function isNegatedF32(inBuf, outBuf) {
  const usable =
    Math.min(inBuf.length, outBuf.length) -
    (Math.min(inBuf.length, outBuf.length) % 4);
  for (let i = 0; i + 3 < usable; i += 4) {
    if (Math.abs(outBuf.readFloatLE(i) + inBuf.readFloatLE(i)) > 1e-6)
      return false;
  }
  return true;
}

async function postAudio(port, audioBase64, sequence, format) {
  const response = await fetch(`http://127.0.0.1:${port}/process-audio`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session: { id: "voice-smoke" },
      audio: {
        sequence,
        sampleRate: 48000,
        channels: 1,
        format,
        audioDataBase64: audioBase64,
      },
      identity: {},
      enabled: { voice: true },
    }),
  });
  const text = await response.text();
  assert(response.ok, `/process-audio HTTP ${response.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}
