// smoke:ai-stage-states
// Forces a stage failure (w-okada down) and verifies the failure is VISIBLE and
// STICKY: session.health=failed, the voice pipeline reports state=failed with a
// stable reason, session.adapterError is set, and — the hysteresis contract —
// it is NOT cleared by the passthrough frames that a down engine keeps
// returning (the old code wiped the error on any non-error status).
//
// Dep-free: only the voice path (stdlib) is exercised, so it never skips for
// missing model weights.

import {
  assert,
  captureOutput,
  getFreePort,
  makeSkip,
  postJson,
  pythonCanImport,
  resolveEndpointPython,
  spawnModelEndpoint,
  spawnSidecar,
  waitForHttpUp,
} from "./support/inproc-smoke.mjs";

const skip = makeSkip("stage states smoke");
const python = resolveEndpointPython();

let endpoint = null;
let sidecar = null;
try {
  if (!(await pythonCanImport(python, ["json", "sys"]))) {
    skip(`endpoint python no disponible (${python}).`);
  }

  const endpointPort = await getFreePort();
  const sidecarPort = await getFreePort();
  // A free (unbound) port -> connection refused -> deterministic wokada_unreachable.
  const deadWokadaPort = await getFreePort();

  endpoint = spawnModelEndpoint(python, endpointPort, {
    SHAPE_MODEL_ENDPOINT_ENGINE: "inproc",
    VCCLIENT000_HTTP_ENDPOINT: `http://127.0.0.1:${deadWokadaPort}/test`,
    SHAPE_VOICE_ENDPOINT_TIMEOUT_SECS: "1",
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
    SHAPE_AUDIO_PROCESSOR_TIMEOUT_SECS: "3",
    SHAPE_STAGE_FAIL_STREAK: "3",
    SHAPE_AI_ACCESS_LOG: "false",
  });
  const sidecarOutput = captureOutput(sidecar);
  await waitForHttpUp(sidecar, sidecarPort, "/health", sidecarOutput);

  const session = await postJson(`http://127.0.0.1:${sidecarPort}/sessions`, {
    meetingCode: "stage-states",
    participantId: "host",
    identityVoiceModelPath: "/tmp/does-not-exist-voice-model",
    faceEnabled: false,
    backgroundEnabled: false,
    voiceEnabled: true,
  });
  assert(session.ok, `/sessions HTTP ${session.status}: ${session.text}`);
  const sessionId = session.data.session?.id;
  assert(sessionId, "no session id");

  // Drive several failing chunks past the fail streak so the stage goes failed.
  const silentChunk = Buffer.alloc(960 * 2, 0).toString("base64");
  let lastAudioStatus = null;
  for (let sequence = 1; sequence <= 5; sequence += 1) {
    const audio = await postJson(
      `http://127.0.0.1:${sidecarPort}/sessions/${sessionId}/audio`,
      {
        sequence,
        timestampMs: Date.now(),
        sampleRate: 48000,
        channels: 1,
        format: "pcm_s16le",
        audioDataBase64: silentChunk,
      },
    );
    assert(audio.ok, `/audio HTTP ${audio.status}: ${audio.text}`);
    assert(
      audio.data.audio?.audio?.audioDataBase64,
      "audio response missing {audio}",
    );
    lastAudioStatus = audio.data.audio.status;
  }
  assert(
    ["degraded", "passthrough"].includes(lastAudioStatus),
    `expected a degraded/passthrough audio result, got ${lastAudioStatus}`,
  );

  const afterFailures = await sessionState(sidecarPort, sessionId);
  assert(
    afterFailures.health === "failed",
    `expected session.health=failed, got ${afterFailures.health}`,
  );
  const voice = afterFailures.pipelines.find((p) => p.id === "voice");
  assert(voice, "no voice pipeline in session payload");
  assert(
    voice.state === "failed",
    `expected voice pipeline state=failed, got ${voice.state}`,
  );
  assert(
    typeof voice.reason === "string" && voice.reason.length > 0,
    `expected a voice failure reason, got ${voice.reason}`,
  );
  assert(
    voice.reason === "wokada_unreachable",
    `expected reason wokada_unreachable, got ${voice.reason}`,
  );
  assert(
    typeof afterFailures.adapterError === "string" &&
      afterFailures.adapterError.includes("voice_"),
    `expected a voice adapterError, got ${afterFailures.adapterError}`,
  );

  // Hysteresis: another passthrough chunk must NOT clear the sticky error.
  const errorBeforePassthrough = afterFailures.adapterError;
  await postJson(
    `http://127.0.0.1:${sidecarPort}/sessions/${sessionId}/audio`,
    {
      sequence: 6,
      timestampMs: Date.now(),
      sampleRate: 48000,
      channels: 1,
      format: "pcm_s16le",
      audioDataBase64: silentChunk,
    },
  );
  const afterPassthrough = await sessionState(sidecarPort, sessionId);
  assert(
    typeof afterPassthrough.adapterError === "string" &&
      afterPassthrough.adapterError.includes("voice_"),
    `adapterError was cleared by a passthrough (hysteresis broken): ${afterPassthrough.adapterError}`,
  );
  assert(
    afterPassthrough.health === "failed",
    "session recovered to healthy after a mere passthrough",
  );

  console.log(
    `stage states smoke ok (voice failed & sticky: reason=${voice.reason}, error persisted "${errorBeforePassthrough.slice(0, 40)}...")`,
  );
} finally {
  if (sidecar) sidecar.kill();
  if (endpoint) endpoint.kill();
}

async function sessionState(port, sessionId) {
  const response = await fetch(
    `http://127.0.0.1:${port}/sessions/${sessionId}`,
  );
  const data = await response.json();
  assert(response.ok, `/sessions/${sessionId} HTTP ${response.status}`);
  return data.session;
}
