import type { NativeApi, StorageCleanupRequest } from "@t3tools/contracts";
import { getWsConnectionState, subscribeWsConnectionState } from "./wsConnectionState";

function waitForSynchronizedConnection(): Promise<void> {
  if (getWsConnectionState().synchronized) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const unsubscribe = subscribeWsConnectionState(() => {
      if (!getWsConnectionState().synchronized) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    });
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Could not check cleanup acceptance after reconnecting."));
    }, 30_000);
  });
}

/** Recover a lost acknowledgement using the original id, only within the same backend epoch. */
export async function acceptStorageCleanup(
  storage: Pick<NativeApi["storage"], "cleanup" | "getStatus" | "getOperation">,
  request: StorageCleanupRequest,
) {
  try {
    return await storage.cleanup(request);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      (!/^WebSocket connection closed\.$|^Request timed out: storage\.cleanup$/.test(
        error.message,
      ) &&
        !("code" in error && error.code === "ConnectionNotReady"))
    )
      throw error;
    await waitForSynchronizedConnection();
    const status = await storage.getStatus();
    if (status.backendEpoch !== request.backendEpoch)
      throw new Error("F5 restarted. Rescan and confirm cleanup again.");
    try {
      return (await storage.getOperation({ operationId: request.operationId })).status;
    } catch (lookupError) {
      if (!(lookupError instanceof Error) || !lookupError.message.includes("operation_unknown"))
        throw lookupError;
    }
    // The first request may not have reached acceptance. Resubmit the exact
    // immutable request once; the backend checks id/hash before consuming a nonce.
    return storage.cleanup(request);
  }
}
