import { fileURLToPath } from "node:url";
import { spawnJsonFixture } from "./process.ts";

export async function connectStoreClient(url: string) {
  return spawnJsonFixture({
    script: fileURLToPath(new URL("../../../web/src/test/chaosClient.ts", import.meta.url)),
    args: [url],
    gracefulQuit: true,
  });
}
