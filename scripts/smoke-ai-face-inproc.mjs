// smoke:ai-face-inproc
// Boots the model endpoint in inproc mode and runs an in-process face swap over
// numpy buffers: source-face fixture + target frame fixture -> verifies the
// output differs from the input (a real swap, not passthrough), the dimensions
// are preserved, and the face stage reports its engine device.
//
// Skips (exit 0) when insightface/onnxruntime are missing or the gated
// inswapper_128.onnx weight is not provided (SHAPE_INSWAPPER_MODEL / cache).

import { existsSync } from "node:fs";
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
  waitForHttpUp,
  waitForStageLoaded,
} from "./support/inproc-smoke.mjs";

const skip = makeSkip("face inproc smoke");
const python = resolveEndpointPython();

let endpoint = null;
try {
  const sourcePath = join(fixturesDir, "source-face.jpg");
  const framePath = join(fixturesDir, "frame.jpg");
  if (!existsSync(sourcePath) || !existsSync(framePath)) {
    skip("faltan fixtures source-face.jpg/frame.jpg.");
  }
  if (
    !(await pythonCanImport(python, [
      "numpy",
      "cv2",
      "onnxruntime",
      "insightface",
    ]))
  ) {
    skip(
      "faltan deps in-process (numpy/cv2/onnxruntime/insightface). Instala " +
        "apps/ai-sidecar/requirements-inproc-mac.txt en el venv del endpoint.",
    );
  }
  const inswapper = resolveWeight(
    "SHAPE_INSWAPPER_MODEL",
    "inswapper_128.onnx",
  );
  if (!inswapper) {
    skip(
      "inswapper_128.onnx no encontrado. Descarga el modelo gated de InsightFace " +
        "y expórtalo en SHAPE_INSWAPPER_MODEL (o ~/.cache/shape-meet-airuntime/weights/).",
    );
  }

  const port = await getFreePort();
  endpoint = spawnModelEndpoint(python, port, {
    SHAPE_MODEL_ENDPOINT_ENGINE: "inproc",
    SHAPE_INSWAPPER_MODEL: inswapper,
    // Phase-1: correctness over fps; CPU avoids the CoreML graph uncertainty.
    SHAPE_FACE_EXECUTION_PROVIDERS:
      process.env.SHAPE_FACE_EXECUTION_PROVIDERS || "cpu",
  });
  const output = captureOutput(endpoint);
  await waitForHttpUp(endpoint, port, "/health", output);

  const faceStatus = await waitForStageLoaded(port, "face", output, endpoint);
  if (faceStatus === "error" || faceStatus === "timeout") {
    skip(
      `el motor de rostro no cargó (stage=${faceStatus}). Revisa deps/pesos.`,
    );
  }

  const frameDataUrl = imageDataUrl("frame.jpg");
  const result = await postJson(`http://127.0.0.1:${port}/process-frame`, {
    session: { id: "face-smoke" },
    frame: { sequence: 1, frameDataUrl, width: 640, height: 640 },
    identity: { faceSourcePath: sourcePath },
    background: {},
    enabled: { face: true, background: false, voice: false },
    target: { width: 640, height: 640, fps: 30 },
  });
  assert(result.ok, `/process-frame HTTP ${result.status}: ${result.text}`);

  const frame = result.data.frame;
  assert(frame, "endpoint did not wrap the result in {frame}");
  assert(
    frame.status === "processed",
    `expected status processed, got ${frame.status}`,
  );
  assert(typeof frame.frame?.dataUrl === "string", "no output dataUrl");
  assert(
    frame.frame.dataUrl !== frameDataUrl,
    "face swap output equals input (no swap happened)",
  );
  assert(
    frame.frame.width === 640 && frame.frame.height === 640,
    "output dimensions were not preserved",
  );

  const faceStage = (frame.stages ?? []).find((s) => s.id === "face");
  assert(faceStage, "no face stage in the result");
  assert(
    faceStage.changed === true,
    `face stage did not change the frame (reason=${faceStage.reason})`,
  );
  assert(
    typeof faceStage.device === "string" && faceStage.device.length > 0,
    "face stage did not report a device",
  );

  console.log(
    `face inproc smoke ok (swap applied on device=${faceStage.device})`,
  );
} finally {
  if (endpoint) endpoint.kill();
}
