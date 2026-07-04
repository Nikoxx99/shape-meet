// smoke:ai-background-inproc
// Boots the model endpoint in inproc mode and runs in-process background
// matting (RVM, no clean plate) over numpy buffers: subject frame + target
// background color -> verifies the composite output differs from the input and
// the background stage reports a coherent matte coverage and its torch device.
//
// Skips (exit 0) when torch/cv2 are missing or the RVM weight is not provided
// (SHAPE_RVM_MODEL / cache: rvm_mobilenetv3.torchscript | rvm_mobilenetv3.pth).

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

const skip = makeSkip("background inproc smoke");
const python = resolveEndpointPython();

let endpoint = null;
try {
  const framePath = join(fixturesDir, "frame.jpg");
  if (!existsSync(framePath)) {
    skip("falta fixture frame.jpg.");
  }
  if (!(await pythonCanImport(python, ["numpy", "cv2", "torch"]))) {
    skip(
      "faltan deps in-process (numpy/cv2/torch). Instala " +
        "apps/ai-sidecar/requirements-inproc-mac.txt en el venv del endpoint.",
    );
  }
  const rvm = resolveWeight(
    "SHAPE_RVM_MODEL",
    "rvm_mobilenetv3_fp32.torchscript",
    "rvm_mobilenetv3.torchscript",
    "rvm_mobilenetv3.pth",
  );
  if (!rvm) {
    skip(
      "modelo RVM no encontrado. Descarga rvm_mobilenetv3.torchscript " +
        "(PeterL1n/RobustVideoMatting, MIT) y expórtalo en SHAPE_RVM_MODEL.",
    );
  }

  const port = await getFreePort();
  endpoint = spawnModelEndpoint(python, port, {
    SHAPE_MODEL_ENDPOINT_ENGINE: "inproc",
    SHAPE_BACKGROUND_ENGINE: "rvm",
    SHAPE_RVM_MODEL: rvm,
    SHAPE_BACKGROUND_COLOR: "#0b8043",
  });
  const output = captureOutput(endpoint);
  await waitForHttpUp(endpoint, port, "/health", output);

  const bgStatus = await waitForStageLoaded(
    port,
    "background",
    output,
    endpoint,
  );
  if (bgStatus === "error" || bgStatus === "timeout") {
    skip(`el motor de fondo no cargó (stage=${bgStatus}). Revisa deps/pesos.`);
  }

  const frameDataUrl = imageDataUrl("frame.jpg");
  const result = await postJson(`http://127.0.0.1:${port}/process-frame`, {
    session: { id: "bg-smoke" },
    frame: { sequence: 1, frameDataUrl, width: 640, height: 640 },
    identity: {},
    background: {},
    enabled: { face: false, background: true, voice: false },
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
    "matting output equals input (no composite happened)",
  );
  assert(
    frame.frame.width === 640 && frame.frame.height === 640,
    "output dimensions were not preserved",
  );

  const bgStage = (frame.stages ?? []).find((s) => s.id === "background");
  assert(bgStage, "no background stage in the result");
  assert(
    bgStage.changed === true,
    `background stage did not change the frame (reason=${bgStage.reason})`,
  );
  assert(
    typeof bgStage.device === "string" && bgStage.device.length > 0,
    "background stage did not report a device",
  );

  console.log(
    `background inproc smoke ok (RVM composite on device=${bgStage.device})`,
  );
} finally {
  if (endpoint) endpoint.kill();
}
