import * as SecureStore from "expo-secure-store";
import { parseTailnetOrigin, type PairedServer } from "./pairing";

const KEY = "f5.servers";
const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
let writes = Promise.resolve();

export async function readPairedServer(): Promise<PairedServer | null> {
  const raw = await SecureStore.getItemAsync(KEY, options);
  if (!raw) return null;
  try {
    const [server] = JSON.parse(raw) as [PairedServer];
    if (
      !server ||
      !/^[A-Za-z0-9_-]{43}$/.test(server.deviceToken) ||
      typeof server.serverId !== "string" ||
      !Array.isArray(server.origins) ||
      server.origins.length === 0 ||
      server.origins.length > 2
    )
      return null;
    return { ...server, origins: server.origins.map(parseTailnetOrigin) };
  } catch {
    return null;
  }
}

export function writePairedServer(server: PairedServer | null) {
  const write = writes.then(() =>
    server
      ? SecureStore.setItemAsync(KEY, JSON.stringify([server]), options)
      : SecureStore.deleteItemAsync(KEY, options),
  );
  writes = write.catch(() => {});
  return write;
}
