// smoke:ai-endpoint-collapsed (scripts/smoke-ai-collapsed-hops.mjs)
// Boots server.py + the model endpoint (inproc) wired with the collapsed
// local-endpoints layout (§2.2): SHAPE_VIDEO/AUDIO_PROCESSOR_ENDPOINT point
// straight at :9100/process-frame|/process-audio and NO *_PROCESSOR_COMMAND is
// set, so no shape_processor_command process is spawned. Validates the
// /sessions/{id}/frames + /audio flow end to end over the single keep-alive hop
// and the {frame}/{audio} contract.
//
// Never red for environment: when the heavy engines/weights are absent the hop
// contract is still validated (frames come back degraded, not processed).

import { join } from "node:path";
import {
  assert,
  captureOutput,
  fixturesDir,
  getFreePort,
  imageDataUrl,
  makeSkip,
  postJson,
  pythonCanImport,
  resolveEndpointPython,
  resolveWeight,
  spawnModelEndpoint,
  spawnSidecar,
  waitForHttpUp,
} from "./support/inproc-smoke.mjs";

const skip = makeSkip("collapsed hops smoke");
const python = resolveEndpointPython();
const FRAME_COUNT = 4;

let endpoint = null;
let sidecar = null;
try {
  if (!(await pythonCanImport(python, ["json", "sys"]))) {
    skip(`endpoint python no disponible (${python}).`);
  }

  const inswapper = resolveWeight(
    "SHAPE_INSWAPPER_MODEL",
    "inswapper_128.onnx",
  );
  const rvm = resolveWeight(
    "SHAPE_RVM_MODEL",
    "rvm_mobilenetv3_fp32.torchscript",
    "rvm_mobilenetv3.torchscript",
    "rvm_mobilenetv3.pth",
  );
  const enginesReady =
    Boolean(inswapper) &&
    Boolean(rvm) &&
    (await pythonCanImport(python, [
      "numpy",
      "cv2",
      "torch",
      "onnxruntime",
      "insightface",
    ]));

  const endpointPort = await getFreePort();
  const sidecarPort = await getFreePort();

  endpoint = spawnModelEndpoint(python, endpointPort, {
    SHAPE_MODEL_ENDPOINT_ENGINE: "inproc",
    SHAPE_BACKGROUND_ENGINE: "rvm",
    SHAPE_BACKGROUND_COLOR: "#0b8043",
    SHAPE_FACE_EXECUTION_PROVIDERS:
      process.env.SHAPE_FACE_EXECUTION_PROVIDERS || "cpu",
    ...(inswapper ? { SHAPE_INSWAPPER_MODEL: inswapper } : {}),
    ...(rvm ? { SHAPE_RVM_MODEL: rvm } : {}),
  });
  const endpointOutput = captureOutput(endpoint);
  await waitForHttpUp(endpoint, endpointPort, "/health", endpointOutput);

  const base = `http://127.0.0.1:${endpointPort}`;
  sidecar = spawnSidecar(python, sidecarPort, {
    SHAPE_AI_MODE: "adapter-contract",
    SHAPE_VIDEO_PROCESSOR_ENDPOINT: `${base}/process-frame`,
    SHAPE_AUDIO_PROCESSOR_ENDPOINT: `${base}/process-audio`,
    SHAPE_MODEL_ENDPOINT_HOST: "127.0.0.1",
    SHAPE_MODEL_ENDPOINT_PORT: String(endpointPort),
    // Generous phase-1 hop budget (correctness over fps on CPU/MPS).
    SHAPE_PROCESSOR_TIMEOUT_SECS: "8",
    SHAPE_AUDIO_PROCESSOR_TIMEOUT_SECS: "6",
    SHAPE_AI_ACCESS_LOG: "false",
  });
  const sidecarOutput = captureOutput(sidecar);
  await waitForHttpUp(sidecar, sidecarPort, "/health", sidecarOutput);

  // The command hop must be gone: no *_PROCESSOR_COMMAND -> no managed process.
  const diag = await (
    await fetch(`http://127.0.0.1:${sidecarPort}/diagnostics`)
  ).json();
  const managed = diag.diagnostics?.managedProcessors ?? [];
  for (const proc of managed) {
    assert(
      proc.commandConfigured === false,
      `expected no ${proc.id} command processor (collapsed hops), got commandConfigured=${proc.commandConfigured}`,
    );
  }
  assert(
    diag.diagnostics?.externalProcessors?.video === true,
    "video external processor not detected",
  );
  assert(
    diag.diagnostics?.externalProcessors?.audio === true,
    "audio external processor not detected",
  );

  const startedRequests = await endpointRequests(endpointPort);

  // Create the session and drive frames through the single collapsed hop.
  const sourcePath = join(fixturesDir, "source-face.jpg");
  const session = await postJson(`http://127.0.0.1:${sidecarPort}/sessions`, {
    meetingCode: "collapsed",
    participantId: "host",
    identityFaceSourcePath: sourcePath,
    faceEnabled: true,
    backgroundEnabled: true,
    voiceEnabled: false,
    targetWidth: 640,
    targetHeight: 640,
  });
  assert(session.ok, `/sessions HTTP ${session.status}: ${session.text}`);
  const sessionId = session.data.session?.id;
  assert(sessionId, "no session id");

  const frameDataUrl = imageDataUrl("frame.jpg");
  let processedCount = 0;
  let changedCount = 0;
  for (let sequence = 1; sequence <= FRAME_COUNT; sequence += 1) {
    const response = await postJson(
      `http://127.0.0.1:${sidecarPort}/sessions/${sessionId}/frames`,
      {
        sequence,
        timestampMs: Date.now(),
        width: 640,
        height: 640,
        frameDataUrl,
        effects: { face: true, background: true, voice: false },
      },
    );
    assert(response.ok, `/frames HTTP ${response.status}: ${response.text}`);
    const frame = response.data.frame;
    assert(frame, "sidecar did not return {frame}");
    assert(typeof frame.frame?.dataUrl === "string", "frame missing dataUrl");
    assert(
      ["processed", "degraded", "passthrough"].includes(frame.status),
      `unexpected frame status ${frame.status}`,
    );
    if (frame.status === "processed") processedCount += 1;
    if (frame.frame.dataUrl !== frameDataUrl) changedCount += 1;
  }

  // Audio contract holds too (voice not enabled -> passthrough {audio}).
  const audio = await postJson(
    `http://127.0.0.1:${sidecarPort}/sessions/${sessionId}/audio`,
    {
      sequence: 1,
      timestampMs: Date.now(),
      sampleRate: 48000,
      channels: 1,
      format: "pcm_s16le",
      audioDataBase64: Buffer.alloc(960 * 2, 0).toString("base64"),
    },
  );
  assert(audio.ok, `/audio HTTP ${audio.status}: ${audio.text}`);
  assert(
    audio.data.audio?.audio?.audioDataBase64,
    "audio response missing {audio}",
  );

  // Every frame reached the endpoint through the single collapsed hop.
  const endedRequests = await endpointRequests(endpointPort);
  assert(
    endedRequests - startedRequests >= FRAME_COUNT,
    `endpoint saw ${endedRequests - startedRequests} processing requests, expected >= ${FRAME_COUNT}`,
  );

  if (enginesReady) {
    assert(
      processedCount >= 1,
      "no frame was fully processed although engines were available",
    );
    assert(
      changedCount >= 1,
      "output never differed from input although engines were available",
    );
    console.log(
      `collapsed hops smoke ok (${processedCount}/${FRAME_COUNT} processed via 1 hop)`,
    );
  } else {
    console.log(
      `collapsed hops smoke ok (contract validated over 1 hop; engines/weights absent, ${changedCount} changed)`,
    );
  }
} finally {
  if (sidecar) sidecar.kill();
  if (endpoint) endpoint.kill();
}

async function endpointRequests(port) {
  const response = await fetch(`http://127.0.0.1:${port}/diagnostics`);
  const data = await response.json();
  return Number(data.diagnostics?.requests ?? 0);
}
