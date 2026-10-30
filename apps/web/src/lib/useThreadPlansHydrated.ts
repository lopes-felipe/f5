import type { OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useStore } from "../store";
import { useWsConnectionState } from "../wsConnectionState";
import { warmThreadBundle } from "./threadPreload";

const inFlight = new Map<ThreadId, Promise<boolean>>();

const plansOmitted = (threadId: ThreadId) =>
  useStore.getState().threads.find((thread) => thread.id === threadId)?.proposedPlansOmitted ===
  true;

/**
 * Loads thread details for a thread whose plans the startup snapshot omitted.
 * Thread detail queries never go stale, so an invalidate would not refetch;
 * this forces the tail, which carries the plans and clears the flag. Resolves
 * `false` when the load finished but the plans are still omitted, for example
 * because a reconnect replaced the state mid-load.
 */
export function hydrateOmittedThreadPlans(
  queryClient: QueryClient,
  threadId: ThreadId,
): Promise<boolean> {
  const existing = inFlight.get(threadId);
  if (existing) return existing;
  const warm = warmThreadBundle(queryClient, threadId, { forceThreadDetails: true })
    .then(() => !plansOmitted(threadId))
    .finally(() => inFlight.delete(threadId));
  inFlight.set(threadId, warm);
  return warm;
}

/** An unarchived thread is live again; load the plans its startup snapshot omitted. */
export function hydrateUnarchivedThreadPlans(
  queryClient: QueryClient,
  events: ReadonlyArray<OrchestrationEvent>,
): void {
  for (const event of events) {
    if (event.type !== "thread.unarchived" || !plansOmitted(event.payload.threadId)) continue;
    void hydrateOmittedThreadPlans(queryClient, event.payload.threadId).catch(() => undefined);
  }
}

/**
 * For components that render a thread's plans: hydrates them when the startup
 * snapshot omitted them (archived threads) and reports whether they are still
 * loading. A load that fails, or finishes with the plans still omitted,
 * reports `failed` until the thread or the flag changes, or until the
 * connection synchronizes again, which retries it.
 */
export function useThreadPlansHydrated(threadId: ThreadId | null | undefined): {
  readonly loading: boolean;
  readonly failed: boolean;
} {
  const queryClient = useQueryClient();
  const omitted = useStore((state) =>
    threadId
      ? state.threads.find((thread) => thread.id === threadId)?.proposedPlansOmitted === true
      : false,
  );
  const connection = useWsConnectionState();
  const connectionReady = connection.phase === "connected" && connection.synchronized;
  const [failedThreadId, setFailedThreadId] = useState<ThreadId | null>(null);
  useEffect(() => {
    if (!threadId || !omitted || !connectionReady) return;
    let cancelled = false;
    setFailedThreadId(null);
    hydrateOmittedThreadPlans(queryClient, threadId).then(
      (loaded) => {
        if (!cancelled && !loaded) setFailedThreadId(threadId);
      },
      () => {
        if (!cancelled) setFailedThreadId(threadId);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [queryClient, threadId, omitted, connectionReady]);
  const failed = omitted && failedThreadId === threadId;
  return { loading: omitted && !failed, failed };
}
