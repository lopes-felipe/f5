import { useSyncExternalStore } from "react";

// Kept out of the route search, so a reveal is not replayed from history or a shared link.
let revealRequestId = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Asks the diff panel to expand and scroll to its selected file again. Each pick of a file from a
 * turn is its own request, so picking the same file after collapsing it reveals it again.
 */
export function requestDiffFileReveal(): void {
  revealRequestId++;
  for (const listener of listeners) listener();
}

export function useDiffFileRevealRequestId(): number {
  return useSyncExternalStore(subscribe, () => revealRequestId);
}
