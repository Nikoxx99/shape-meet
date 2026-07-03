import { Room, RoomEvent, type RoomConnectOptions } from "livekit-client";

export interface LiveKitJoinInput {
  url: string;
  token: string;
  options?: RoomConnectOptions;
  timeoutMs?: number;
}

export async function connectLiveKitRoom(input: LiveKitJoinInput): Promise<Room> {
  const room = new Room({
    adaptiveStream: true,
    dynacast: true
  });

  room.on(RoomEvent.Disconnected, () => {
    console.info("[shape-meet] LiveKit room disconnected");
  });

  try {
    await connectWithTimeout(room, input);
  } catch (error) {
    room.disconnect();
    throw error;
  }

  return room;
}

async function connectWithTimeout(room: Room, input: LiveKitJoinInput) {
  const timeoutMs = input.timeoutMs ?? 15000;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  try {
    await Promise.race([
      room.connect(input.url, input.token, input.options),
      new Promise<never>((_, reject) => {
        const seconds = Math.round(timeoutMs / 1000);
        timeoutId = setTimeout(
          () =>
            reject(
              new Error(
                `LiveKit no completó WebRTC en ${seconds}s. Revisa LIVEKIT_URL, LIVEKIT_NODE_IP y los puertos ICE/TURN expuestos.`
              )
            ),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
