import { createServer } from "node:http";

const kind = process.argv[2] ?? process.env.SHAPE_PROCESSOR_KIND ?? "video";
const port = Number(process.argv[3] ?? process.env.SHAPE_PROCESSOR_PORT ?? 0);

if (!port) {
  console.error("mock-ai-processor requires a port argument or SHAPE_PROCESSOR_PORT");
  process.exit(1);
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    writeJson(response, 200, { status: "ready", kind });
    return;
  }

  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed" });
    return;
  }

  try {
    const payload = JSON.parse(await readRequestBody(request));
    if (kind === "audio") {
      writeJson(response, 200, audioResponse(payload));
      return;
    }

    writeJson(response, 200, videoResponse(payload));
  } catch (error) {
    writeJson(response, 500, { error: "mock_processor_failed", message: error.message });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock ${kind} processor listening on ${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}

function videoResponse(payload) {
  const frame = payload.frame ?? {};
  const target = payload.target ?? {};

  return {
    frame: {
      sequence: frame.sequence ?? 0,
      status: "processed",
      processor: "managed-video-mock",
      frame: {
        dataUrl: frame.frameDataUrl,
        width: target.width ?? frame.width ?? 1280,
        height: target.height ?? frame.height ?? 720,
        format: "image/jpeg"
      },
      metrics: {
        fps: target.fps ?? 30,
        latencyMs: 9,
        framesProcessed: 1,
        vramMb: 2048,
        resolution: `${target.width ?? frame.width ?? 1280}x${target.height ?? frame.height ?? 720}`
      },
      warnings: ["managed_video_mock"]
    }
  };
}

function audioResponse(payload) {
  const audio = payload.audio ?? {};

  return {
    audio: {
      sequence: audio.sequence ?? 0,
      status: "processed",
      processor: "managed-audio-mock",
      audio: {
        audioDataBase64: audio.audioDataBase64,
        sampleRate: audio.sampleRate ?? 48000,
        channels: audio.channels ?? 1,
        format: audio.format ?? "pcm_f32le"
      },
      metrics: {
        chunksProcessed: 1,
        latencyMs: 6,
        inputBytes: String(audio.audioDataBase64 ?? "").length
      },
      warnings: ["managed_audio_mock"]
    }
  };
}

function writeJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}
