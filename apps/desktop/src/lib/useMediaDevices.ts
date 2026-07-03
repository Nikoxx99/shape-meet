import { useCallback, useEffect, useMemo, useState } from "react";

export interface DeviceSelection {
  cameraId: string;
  microphoneId: string;
  speakerId: string;
}

export interface MediaDeviceChoice {
  id: string;
  label: string;
  kind: MediaDeviceKind;
}

type MediaDeviceKind = "audioinput" | "audiooutput" | "videoinput";

const STORAGE_KEY = "shape-meet-device-selection";

const EMPTY_SELECTION: DeviceSelection = {
  cameraId: "",
  microphoneId: "",
  speakerId: ""
};

export function readStoredDeviceSelection(): DeviceSelection {
  if (typeof window === "undefined") return EMPTY_SELECTION;

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return EMPTY_SELECTION;
    const parsed = JSON.parse(stored) as Partial<DeviceSelection>;

    return {
      cameraId: typeof parsed.cameraId === "string" ? parsed.cameraId : "",
      microphoneId: typeof parsed.microphoneId === "string" ? parsed.microphoneId : "",
      speakerId: typeof parsed.speakerId === "string" ? parsed.speakerId : ""
    };
  } catch {
    return EMPTY_SELECTION;
  }
}

export function writeStoredDeviceSelection(selection: DeviceSelection) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
}

export function useMediaDevices() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [permissionRequested, setPermissionRequested] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setError("Este runtime no expone dispositivos de audio/video.");
      setDevices([]);
      return;
    }

    setRefreshing(true);

    try {
      const nextDevices = await navigator.mediaDevices.enumerateDevices();
      setDevices(nextDevices);
      setError(null);
    } catch (deviceError) {
      setError(deviceError instanceof Error ? deviceError.message : "No se pudieron leer los dispositivos.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  const requestDeviceAccess = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Este runtime no permite abrir cámara o micrófono.");
      return;
    }

    setPermissionRequested(true);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      stream.getTracks().forEach((track) => track.stop());
      await refresh();
    } catch (deviceError) {
      setError(deviceError instanceof Error ? deviceError.message : "No se pudo abrir cámara o micrófono.");
      await refresh();
    }
  }, [refresh]);

  useEffect(() => {
    void refresh();

    if (!navigator.mediaDevices) return undefined;

    const handleDeviceChange = () => {
      void refresh();
    };

    navigator.mediaDevices.addEventListener?.("devicechange", handleDeviceChange);
    return () => navigator.mediaDevices.removeEventListener?.("devicechange", handleDeviceChange);
  }, [refresh]);

  const choices = useMemo(() => buildDeviceChoices(devices), [devices]);

  return {
    devices,
    choices,
    error,
    permissionRequested,
    refreshing,
    refresh,
    requestDeviceAccess
  };
}

export function normalizeDeviceSelection(selection: DeviceSelection, choices: Record<MediaDeviceKind, MediaDeviceChoice[]>): DeviceSelection {
  return {
    cameraId: hasDevice(choices.videoinput, selection.cameraId) ? selection.cameraId : choices.videoinput[0]?.id ?? "",
    microphoneId: hasDevice(choices.audioinput, selection.microphoneId) ? selection.microphoneId : choices.audioinput[0]?.id ?? "",
    speakerId: hasDevice(choices.audiooutput, selection.speakerId) ? selection.speakerId : choices.audiooutput[0]?.id ?? ""
  };
}

export function deviceLabel(choices: MediaDeviceChoice[], id: string, fallback: string) {
  return choices.find((choice) => choice.id === id)?.label ?? choices[0]?.label ?? fallback;
}

function buildDeviceChoices(devices: MediaDeviceInfo[]): Record<MediaDeviceKind, MediaDeviceChoice[]> {
  return {
    videoinput: mapDevices(devices, "videoinput", "Cámara"),
    audioinput: mapDevices(devices, "audioinput", "Micrófono"),
    audiooutput: mapDevices(devices, "audiooutput", "Salida")
  };
}

function mapDevices(devices: MediaDeviceInfo[], kind: MediaDeviceKind, fallbackPrefix: string): MediaDeviceChoice[] {
  return devices
    .filter((device) => device.kind === kind && device.deviceId)
    .map((device, index) => ({
      id: device.deviceId,
      label: device.label || `${fallbackPrefix} ${index + 1}`,
      kind
    }));
}

function hasDevice(devices: MediaDeviceChoice[], id: string) {
  if (!id) return false;
  return devices.some((device) => device.id === id);
}
