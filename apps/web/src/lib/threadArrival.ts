import type { ThreadId } from "@t3tools/contracts";

import { useStore } from "../store";

const THREAD_ARRIVAL_TIMEOUT_MS = 10_000;

/**
 * Resolves true once a thread the server just created has reached the store, false when it
 * has not after the timeout. Its creation event can land after the reply that named it, and
 * the thread route sends an unknown thread back to Home.
 */
export function waitForThreadInStore(
  threadId: ThreadId,
  timeoutMs = THREAD_ARRIVAL_TIMEOUT_MS,
): Promise<boolean> {
  const present = () => useStore.getState().threads.some((thread) => thread.id === threadId);
  if (present()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      resolve(false);
    }, timeoutMs);
    const unsubscribe = useStore.subscribe(() => {
      if (!present()) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(true);
    });
  });
}
