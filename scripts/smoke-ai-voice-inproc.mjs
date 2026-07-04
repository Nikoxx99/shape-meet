// smoke:ai-voice-inproc
// Boots the model endpoint in inproc mode against a MOCK w-okada server and
// verifies the persistent in-process voice client converts PCM -> S16 -> POST
// -> S16 -> PCM correctly (format round-trip) and REUSES the keep-alive
// connection across chunks (>1 request on the same TCP connection).
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
  fail,
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

let endpoint = null;
let mock = null;
let mockConnections = 0;
let mockRequests = 0;

try {
  if (!(await pythonCanImport(python, ["json", "sys"]))) {
    skip(`endpoint python no disponible (${python}).`);
  }
  if (!existsSync(chunkPath)) {
    skip(`falta fixture ${chunkPath}.`);
  }

  const mockPort = await getFreePort();
  mock = startMockWokada(mockPort);
  await once(mock, "listening");

  const endpointPort = await getFreePort();
  endpoint = spawnModelEndpoint(python, endpointPort, {
    SHAPE_MODEL_ENDPOINT_ENGINE: "inproc",
    VCCLIENT000_HTTP_ENDPOINT: `http://127.0.0.1:${mockPort}/test`,
    SHAPE_VOICE_ENDPOINT_TIMEOUT_SECS: "5",
  });
  const output = captureOutput(endpoint);
  await waitForHttpUp(endpoint, endpointPort, "/health", output);

  const chunkBase64 = readFileSync(chunkPath).toString("base64");
  const first = await postAudio(endpointPort, chunkBase64, 1);
  assert(
    first.audio?.status === "processed",
    `voice chunk 1 not processed: ${first.audio?.status}`,
  );
  const stage1 = (first.audio?.stages ?? []).find((s) => s.id === "voice");
  assert(stage1?.changed === true, "voice stage 1 did not change audio");

  const outBase64 = first.audio?.audio?.audioDataBase64;
  assert(
    typeof outBase64 === "string" && outBase64.length > 0,
    "voice chunk 1 returned no audio",
  );
  const inBuf = Buffer.from(chunkBase64, "base64");
  const outBuf = Buffer.from(outBase64, "base64");
  assert(
    outBuf.length === inBuf.length,
    `round-trip length mismatch: in=${inBuf.length} out=${outBuf.length}`,
  );
  assert(
    !outBuf.equals(inBuf),
    "voice output equals input (no transform applied)",
  );
  assert(
    isNegatedS16(inBuf, outBuf),
    "voice round-trip did not preserve the mock S16 transform",
  );

  const second = await postAudio(endpointPort, chunkBase64, 2);
  const stage2 = (second.audio?.stages ?? []).find((s) => s.id === "voice");
  assert(stage2?.changed === true, "voice stage 2 did not change audio");
  assert(
    Number(stage2?.requestsOnConnection) >= 2,
    `expected >=2 requests on the same connection, got ${stage2?.requestsOnConnection}`,
  );
  assert(
    Number(stage2?.connectionsOpened) === 1,
    `expected exactly 1 opened connection, got ${stage2?.connectionsOpened}`,
  );
  assert(mockRequests >= 2, `mock w-okada received ${mockRequests} requests`);
  assert(
    mockConnections === 1,
    `keep-alive not reused: mock saw ${mockConnections} TCP connections`,
  );

  console.log("voice inproc smoke ok (round-trip + keep-alive reuse)");
} finally {
  if (endpoint) endpoint.kill();
  if (mock) mock.close();
}

function startMockWokada(port) {
  const server = createHttpServer((req, res) => {
    if (req.method !== "POST" || !req.url.startsWith("/test")) {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      mockRequests += 1;
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
    mockConnections += 1;
  });
  server.listen(port, "127.0.0.1");
  return server;
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

async function postAudio(port, audioBase64, sequence) {
  const response = await fetch(`http://127.0.0.1:${port}/process-audio`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session: { id: "voice-smoke" },
      audio: {
        sequence,
        sampleRate: 48000,
        channels: 1,
        format: "pcm_s16le",
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
