import { useCreateProjectBackedDraftThread } from "./useCreateProjectBackedDraftThread";
import { useStableCallback } from "./useStableCallback";
import { useStartupReady } from "../lib/startupReady";

// Activations and drops share one lane, including across mounted consumers.
let opening: Promise<unknown> = Promise.resolve();

export function useOpenLocalWorkspace() {
  const ready = useStartupReady();
  const createThread = useCreateProjectBackedDraftThread();
  const open = useStableCallback((path: string, check: () => Promise<void> = async () => {}) => {
    const operation = opening
      .catch(() => {})
      .then(async () => {
        if (!ready) throw new Error("This computer's server is not connected yet.");
        const { openLocalWorkspace } = await import("../lib/openLocalWorkspace");
        await openLocalWorkspace(path, createThread, check);
      });
    opening = operation;
    return operation;
  });
  return { ready, open };
}
