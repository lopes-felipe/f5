import type { RewindDraftState } from "@t3tools/contracts";

export type RewindDraftTone = "working" | "error" | "warning" | "ready";

export type RewindDraftAction = "retry" | "cancel" | "recheck" | "discard" | "edit";

export interface RewindDraftCopy {
  readonly tone: RewindDraftTone;
  readonly title: string;
  /** Extra explanation shown under the server's error, if any. */
  readonly hint: string | null;
  readonly actions: ReadonlyArray<RewindDraftAction>;
}

/**
 * Human copy for every rewind state. Exhaustive on purpose: a new server state
 * fails the typecheck here instead of leaking its raw name into the UI.
 */
export function describeRewindDraft(input: {
  readonly state: RewindDraftState;
  readonly error?: string | null | undefined;
}): RewindDraftCopy {
  switch (input.state) {
    case "prepared":
      return input.error
        ? {
            tone: "error",
            title: "Revert didn't finish",
            hint: "Nothing was changed. It's safe to try again.",
            actions: ["cancel", "retry"],
          }
        : { tone: "working", title: "Reverting…", hint: null, actions: [] };
    case "provider-pending":
    case "provider-confirmed":
    case "files-confirmed":
      return { tone: "working", title: "Finishing revert…", hint: null, actions: [] };
    case "reconciliation-required":
      return {
        tone: "warning",
        title: "Revert needs a check",
        hint: "The agent's history and this thread may not match. Recheck to verify.",
        actions: ["recheck"],
      };
    case "completed":
      return {
        tone: "ready",
        title: "Your reverted prompt",
        hint: null,
        actions: ["discard", "edit"],
      };
    default: {
      const unhandled: never = input.state;
      return unhandled;
    }
  }
}

/** True while the server is still working on the rewind (not parked on an error). */
export function isRewindInFlight(input: {
  readonly state: RewindDraftState;
  readonly error?: string | null | undefined;
}): boolean {
  return describeRewindDraft(input).tone === "working";
}

const REWIND_FAILED_ACTIVITY_KIND = "conversation.rewind.failed";

/**
 * Drops rewind failure activities whose operation is no longer open. Those have
 * `turnId: null`, so reverts never prune them, and every failed attempt would
 * otherwise stay in the timeline after it was retried, cancelled, or completed.
 * Failures from before operations were recorded on the activity are dropped too.
 *
 * The newest failure is kept when the rewind never started (preflight): it has no
 * panel, and its toast only shows on this thread, so this is its lasting record.
 */
export function withoutSettledRewindFailures<
  T extends { readonly kind: string; readonly payload: unknown },
>(activities: ReadonlyArray<T>, openOperationIds: ReadonlySet<string>): ReadonlyArray<T> {
  const latestFailure = activities.findLast(
    (activity) => activity.kind === REWIND_FAILED_ACTIVITY_KIND,
  );
  let changed = false;
  const kept = activities.filter((activity) => {
    if (activity.kind !== REWIND_FAILED_ACTIVITY_KIND) return true;
    const payload = activity.payload as
      | { operationId?: unknown; stage?: unknown }
      | null
      | undefined;
    const open =
      typeof payload?.operationId === "string" && openOperationIds.has(payload.operationId);
    const latestPreflight = activity === latestFailure && payload?.stage === "preflight";
    if (!open && !latestPreflight) changed = true;
    return open || latestPreflight;
  });
  return changed ? kept : activities;
}

/** Label for the status pill shown at the revert target while it runs. */
export function describePendingRevert(input: {
  readonly restoreFiles: boolean;
  readonly state?: RewindDraftState | undefined;
  readonly providerLabel?: string | undefined;
}): string {
  if (input.state === "provider-pending")
    return `Waiting for ${input.providerLabel ?? "the agent"} to confirm…`;
  if (input.state === "provider-confirmed" && input.restoreFiles) return "Restoring files…";
  return input.restoreFiles ? "Reverting conversation and files…" : "Reverting conversation…";
}
