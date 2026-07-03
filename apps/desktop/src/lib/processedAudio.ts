import { processAiAudio } from "./aiSidecar";

export interface ProcessedAudioOptions {
  voiceEnabled: boolean;
  aiSessionId?: string | null;
  onStatusChange?: (status: ProcessedAudioRuntimeStatus) => void;
}

export interface ProcessedAudioPipeline {
  track: MediaStreamTrack;
  stop: () => void;
  getStatus: () => ProcessedAudioRuntimeStatus;
}

export interface ProcessedAudioRuntimeStatus {
  mode: "sidecar-bridge" | "vcclient000-ready" | "local-passthrough";
  state: "starting" | "processing" | "fallback" | "stopped";
  message: string;
  inputLevel: number;
  framesProcessed: number;
  latencyMs: number | null;
  processor: string | null;
  warnings: string[];
  lastError: string | null;
}

const CAPTURE_BUFFER_SIZE = 2048;
const STATUS_INTERVAL_MS = 500;
const PROCESSED_AUDIO_STALE_MS = 900;
const PLAYBACK_SAFETY_DELAY_SECONDS = 0.035;

export async function createProcessedAudioPipeline(inputTrack: MediaStreamTrack, options: ProcessedAudioOptions): Promise<ProcessedAudioPipeline> {
  const AudioContextCtor = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

  if (!AudioContextCtor) {
    throw new Error("Web Audio no disponible para el pipeline de voz.");
  }

  const audioContext = new AudioContextCtor({ sampleRate: 48000 });
  await audioContext.resume();

  const inputStream = new MediaStream([inputTrack]);
  const source = audioContext.createMediaStreamSource(inputStream);
  const passthroughGain = audioContext.createGain();
  const processedGain = audioContext.createGain();
  const silentOutputGain = audioContext.createGain();
  const analyser = audioContext.createAnalyser();
  const destination = audioContext.createMediaStreamDestination();
  const captureNode = audioContext.createScriptProcessor(CAPTURE_BUFFER_SIZE, 1, 1);

  analyser.fftSize = 512;
  passthroughGain.gain.value = 1;
  processedGain.gain.value = 1;
  silentOutputGain.gain.value = 0;

  source.connect(analyser);
  source.connect(passthroughGain);
  source.connect(captureNode);
  passthroughGain.connect(destination);
  processedGain.connect(destination);
  captureNode.connect(silentOutputGain);
  silentOutputGain.connect(audioContext.destination);

  const [track] = destination.stream.getAudioTracks();

  if (!track) {
    throw new Error("No se pudo crear el track de voz procesada.");
  }

  let stopped = false;
  let framesProcessed = 0;
  let sidecarInFlight = false;
  let sidecarFailures = 0;
  let sequence = 0;
  let inputLevel = 0;
  let lastProcessedAudioAt = 0;
  let nextPlaybackTime = audioContext.currentTime;
  const sidecarEnabled = Boolean(options.aiSessionId && options.voiceEnabled);
  let status: ProcessedAudioRuntimeStatus = {
    mode: sidecarEnabled ? "sidecar-bridge" : "local-passthrough",
    state: "starting",
    message: sidecarEnabled ? "Bridge de voz conectado al sidecar." : "Publicando voz local.",
    inputLevel: 0,
    framesProcessed,
    latencyMs: null,
    processor: null,
    warnings: [],
    lastError: null
  };
  const analyserSamples = new Uint8Array(analyser.frequencyBinCount);

  function updateStatus(next: Partial<ProcessedAudioRuntimeStatus>) {
    status = { ...status, ...next };
    options.onStatusChange?.(status);
  }

  function setPassthrough(active: boolean) {
    const now = audioContext.currentTime;
    passthroughGain.gain.cancelScheduledValues(now);
    passthroughGain.gain.setTargetAtTime(active ? 1 : 0, now, 0.025);
  }

  function publishStatus() {
    if (stopped) return;

    analyser.getByteTimeDomainData(analyserSamples);
    inputLevel = Math.max(inputLevel * 0.7, rmsByteLevel(analyserSamples));

    const processedAudioIsFresh = sidecarEnabled && lastProcessedAudioAt > 0 && performance.now() - lastProcessedAudioAt < PROCESSED_AUDIO_STALE_MS;
    if (sidecarEnabled && !processedAudioIsFresh && sidecarFailures > 0) {
      setPassthrough(true);
    }

    updateStatus({
      mode: sidecarEnabled && processedAudioIsFresh ? status.mode : sidecarEnabled && sidecarFailures > 2 ? "local-passthrough" : status.mode,
      state: sidecarEnabled && sidecarFailures > 2 ? "fallback" : "processing",
      inputLevel,
      framesProcessed,
      message: sidecarEnabled
        ? processedAudioIsFresh
          ? "Voz procesada inyectada en el track."
          : "Bridge de voz enviando PCM al sidecar."
        : options.voiceEnabled
          ? "Track de voz publicado."
          : "Micrófono publicado."
    });
  }

  captureNode.onaudioprocess = (event) => {
    if (stopped) return;

    const input = event.inputBuffer.getChannelData(0);
    const pcm = new Float32Array(input.length);
    pcm.set(input);
    inputLevel = rmsFloatLevel(pcm);
    framesProcessed += 1;

    if (!sidecarEnabled || sidecarInFlight) return;

    sidecarInFlight = true;
    const currentSequence = ++sequence;
    const encodedAudio = floatsToBase64PcmF32(pcm);

    void processAiAudio(options.aiSessionId!, {
      sequence: currentSequence,
      timestampMs: Date.now(),
      sampleRate: audioContext.sampleRate,
      channels: 1,
      format: "pcm_f32le",
      audioDataBase64: encodedAudio
    })
      .then((result) => {
        if (stopped || result.sequence !== currentSequence) return;

        const decoded = decodeAudioPayload(result.audio);
        const injected = decoded ? scheduleProcessedAudio(audioContext, processedGain, decoded, nextPlaybackTime) : null;
        if (injected) {
          nextPlaybackTime = injected.nextPlaybackTime;
          lastProcessedAudioAt = performance.now();
          sidecarFailures = 0;
          setPassthrough(false);
        } else {
          sidecarFailures += 1;
          setPassthrough(true);
        }

        updateStatus({
          mode: injected ? audioModeForProcessor(result.processor) : "local-passthrough",
          state: result.status === "error" || !injected ? "fallback" : "processing",
          message: injected ? audioBridgeMessage(result.processor, decoded?.format) : "Audio del sidecar no inyectable; usando micrófono local.",
          latencyMs: result.metrics.latencyMs,
          processor: result.processor,
          warnings: result.warnings ?? [],
          lastError: injected ? null : "Formato de audio no soportado por el cliente."
        });
      })
      .catch((error) => {
        if (stopped) return;

        sidecarFailures += 1;
        setPassthrough(true);
        updateStatus({
          mode: "local-passthrough",
          state: "fallback",
          message: sidecarFailures > 2 ? "Sidecar de voz sin respuesta; publicando micrófono local." : "Esperando sidecar de voz.",
          lastError: error instanceof Error ? error.message : "No se pudo procesar audio."
        });
      })
      .finally(() => {
        sidecarInFlight = false;
      });
  };

  const interval = window.setInterval(publishStatus, STATUS_INTERVAL_MS);

  updateStatus({});

  return {
    track,
    getStatus: () => status,
    stop: () => {
      stopped = true;
      window.clearInterval(interval);
      captureNode.onaudioprocess = null;
      updateStatus({ state: "stopped", message: "Pipeline de voz detenido." });
      source.disconnect();
      passthroughGain.disconnect();
      processedGain.disconnect();
      silentOutputGain.disconnect();
      analyser.disconnect();
      captureNode.disconnect();
      track.stop();
      inputTrack.stop();
      void audioContext.close().catch(() => undefined);
    }
  };
}

interface DecodedAudioPayload {
  sampleRate: number;
  channels: Float32Array[];
  frameCount: number;
  format: string;
}

function scheduleProcessedAudio(
  audioContext: AudioContext,
  output: AudioNode,
  payload: DecodedAudioPayload,
  previousPlaybackTime: number
) {
  if (payload.frameCount <= 0 || payload.channels.length === 0) return null;

  const buffer = audioContext.createBuffer(payload.channels.length, payload.frameCount, payload.sampleRate);

  payload.channels.forEach((channel, index) => {
    buffer.getChannelData(index).set(channel);
  });

  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(output);

  const startAt = Math.max(audioContext.currentTime + PLAYBACK_SAFETY_DELAY_SECONDS, previousPlaybackTime);
  source.start(startAt);
  source.addEventListener("ended", () => source.disconnect());

  return { nextPlaybackTime: startAt + buffer.duration };
}

function decodeAudioPayload(audio: { audioDataBase64: string; sampleRate: number; channels: number; format: string } | undefined) {
  if (!audio?.audioDataBase64) return null;

  const bytes = base64ToBytes(audio.audioDataBase64);
  const sampleRate = Number.isFinite(audio.sampleRate) && audio.sampleRate > 0 ? audio.sampleRate : 48000;
  const channelCount = Math.max(1, Math.min(2, Math.floor(audio.channels || 1)));
  const format = audio.format.toLowerCase();

  if (format === "pcm_f32le" || format === "f32le" || format === "float32") {
    const sampleCount = Math.floor(bytes.byteLength / 4);
    return interleavedToChannels(sampleCount, channelCount, format, (view, offset) => view.getFloat32(offset, true), bytes, sampleRate);
  }

  if (format === "pcm_s16le" || format === "s16le" || format === "int16") {
    const sampleCount = Math.floor(bytes.byteLength / 2);
    return interleavedToChannels(sampleCount, channelCount, format, (view, offset) => view.getInt16(offset, true) / 32768, bytes, sampleRate, 2);
  }

  if (format === "uint8-time-domain" || format === "u8") {
    const frameCount = Math.floor(bytes.byteLength / channelCount);
    const channels = Array.from({ length: channelCount }, () => new Float32Array(frameCount));

    for (let frame = 0; frame < frameCount; frame += 1) {
      for (let channel = 0; channel < channelCount; channel += 1) {
        channels[channel]![frame] = (bytes[frame * channelCount + channel]! - 128) / 128;
      }
    }

    return { sampleRate, channels, frameCount, format };
  }

  return null;
}

function interleavedToChannels(
  sampleCount: number,
  channelCount: number,
  format: string,
  readSample: (view: DataView, offset: number) => number,
  bytes: Uint8Array,
  sampleRate: number,
  bytesPerSample = 4
): DecodedAudioPayload | null {
  const frameCount = Math.floor(sampleCount / channelCount);
  if (frameCount <= 0) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frameCount));

  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const sampleIndex = frame * channelCount + channel;
      channels[channel]![frame] = clampAudioSample(readSample(view, sampleIndex * bytesPerSample));
    }
  }

  return { sampleRate, channels, frameCount, format };
}

function rmsByteLevel(samples: Uint8Array) {
  let sum = 0;

  for (const sample of samples) {
    const normalized = (sample - 128) / 128;
    sum += normalized * normalized;
  }

  return Math.min(1, Math.sqrt(sum / samples.length));
}

function rmsFloatLevel(samples: Float32Array) {
  let sum = 0;

  for (const sample of samples) {
    sum += sample * sample;
  }

  return Math.min(1, Math.sqrt(sum / samples.length));
}

function floatsToBase64PcmF32(samples: Float32Array) {
  const bytes = new Uint8Array(samples.length * 4);
  const view = new DataView(bytes.buffer);

  for (let index = 0; index < samples.length; index += 1) {
    view.setFloat32(index * 4, clampAudioSample(samples[index] ?? 0), true);
  }

  return bytesToBase64(bytes);
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function clampAudioSample(value: number) {
  return Math.max(-1, Math.min(1, value));
}

function audioModeForProcessor(processor: string): ProcessedAudioRuntimeStatus["mode"] {
  return processor === "development-passthrough" || processor === "adapter-contract" ? "sidecar-bridge" : "vcclient000-ready";
}

function audioBridgeMessage(processor: string, format?: string) {
  const suffix = format ? ` (${format})` : "";

  if (processor === "development-passthrough") return `Sidecar de voz inyectando passthrough${suffix}.`;
  if (processor === "adapter-contract") return `Contrato de voz inyectable activo${suffix}.`;
  return `${processor} procesando voz${suffix}.`;
}
