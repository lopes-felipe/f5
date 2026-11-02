// Longer than the shutdown budget (renderer unload, then backends get SIGTERM, a
// 5 s grace and SIGKILL inside cleanupBeforeExit's 6 s race), so a double Cmd-Q
// at the start of a normal quit cannot cut the backend stop short and orphan it.
export const QUIT_STALL_THRESHOLD_MS = 10_000;

export interface QuitStallTracker {
  /** Marks the start of a quit. A quit already in progress keeps its start time. */
  readonly begin: () => void;
  /** Forgets the quit, for example after a renderer vetoed it. */
  readonly reset: () => void;
  /** Milliseconds since the quit began, or null when no quit is in progress. */
  readonly pendingMs: () => number | null;
}

/**
 * Times a pending quit. The default clock is monotonic, so an NTP correction
 * or a sleep/wake jump cannot make a normal double Cmd-Q look stalled.
 */
export function makeQuitStallTracker(
  now: () => number = () => performance.now(),
): QuitStallTracker {
  let startedAt: number | undefined;
  return {
    begin: () => {
      startedAt ??= now();
    },
    reset: () => {
      startedAt = undefined;
    },
    pendingMs: () => (startedAt === undefined ? null : Math.max(0, now() - startedAt)),
  };
}

export type QuitRequestDecision =
  /** No quit is in progress: start shutdown and its clock. */
  | { readonly kind: "begin" }
  /** Shutdown finished; this is its own final quit, so let it through. */
  | { readonly kind: "complete" }
  /** The update installer owns this quit; its cleanup must not be cut short. */
  | { readonly kind: "deferred" }
  /** A repeat while shutdown is within its budget: swallow it. */
  | { readonly kind: "pending"; readonly pendingMs: number }
  /** A repeat after shutdown stalled: exit without it. */
  | { readonly kind: "stalled"; readonly pendingMs: number };

/**
 * Classifies a Quit or SIGINT/SIGTERM. While a quit waits on shutdown, repeats
 * are swallowed; once that shutdown has stalled past the threshold, a repeat
 * is the user's only way out short of SIGKILL.
 */
export function classifyQuitRequest(input: {
  readonly tracker: QuitStallTracker;
  readonly shutdownComplete: boolean;
  readonly updateInstallOwnsQuit: boolean;
  readonly thresholdMs?: number;
}): QuitRequestDecision {
  if (input.shutdownComplete) return { kind: "complete" };
  if (input.updateInstallOwnsQuit) return { kind: "deferred" };
  const pendingMs = input.tracker.pendingMs();
  if (pendingMs === null) return { kind: "begin" };
  return pendingMs >= (input.thresholdMs ?? QUIT_STALL_THRESHOLD_MS)
    ? { kind: "stalled", pendingMs }
    : { kind: "pending", pendingMs };
}
