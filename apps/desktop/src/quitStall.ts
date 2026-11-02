// Longer than the shutdown budget (renderer unload, then backends get SIGTERM, a
// 5 s grace and SIGKILL inside cleanupBeforeExit's 6 s race), so a double Cmd-Q
// at the start of a normal quit cannot cut the backend stop short and orphan it.
export const QUIT_STALL_THRESHOLD_MS = 10_000;

export type QuitStallDecision =
  | { readonly kind: "pending"; readonly pendingMs: number }
  | { readonly kind: "stalled"; readonly pendingMs: number };

export interface QuitStallTracker {
  /** Marks the start of a quit. A quit already in progress keeps its start time. */
  readonly begin: () => void;
  /** Forgets the quit, for example after a renderer vetoed it. */
  readonly reset: () => void;
  /** Classifies a repeated Quit or signal that arrived while a quit is in progress. */
  readonly check: () => QuitStallDecision;
}

/**
 * While a quit waits on shutdown, repeated Quit and SIGTERM are swallowed. If
 * that shutdown stalls, a repeat is the user's only way out short of SIGKILL,
 * so once it has been pending past the threshold the caller exits instead.
 */
export function makeQuitStallTracker(
  now: () => number = Date.now,
  thresholdMs = QUIT_STALL_THRESHOLD_MS,
): QuitStallTracker {
  let startedAt: number | undefined;
  return {
    begin: () => {
      startedAt ??= now();
    },
    reset: () => {
      startedAt = undefined;
    },
    check: () => {
      const current = now();
      startedAt ??= current;
      const pendingMs = Math.max(0, current - startedAt);
      return { kind: pendingMs >= thresholdMs ? "stalled" : "pending", pendingMs };
    },
  };
}
