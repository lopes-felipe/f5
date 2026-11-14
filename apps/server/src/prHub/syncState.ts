import type { PrHubSchedulerState, PrHubSnapshot, PrHubSyncState } from "@t3tools/contracts";

import { PR_HUB_BACKLOG_ERROR_KIND } from "./refreshSchedule.ts";

/**
 * One answer to "is monitoring healthy?". Work that resumes on its own (request budget,
 * detail backlog, unfinished pagination) is "syncing"; only a read that failed is "error".
 */
export function prHubSyncState(
  snapshot: Pick<
    PrHubSnapshot,
    "status" | "lastPolledAt" | "errorKind" | "errorMessage" | "coverage"
  >,
  scheduler: PrHubSchedulerState | undefined,
  nextSyncAt: string | null,
  now = Date.now(),
): PrHubSyncState {
  const coverage = snapshot.coverage ?? [];
  const pending = {
    searches: coverage.reduce((total, scope) => total + (scope.remainingSearches ?? 0), 0),
    // Every scope reports the same detail queue, so the largest figure is the queue.
    hydrations: coverage.reduce((most, scope) => Math.max(most, scope.remainingHydrations ?? 0), 0),
  };
  const future = (value: string | null | undefined) =>
    value && Date.parse(value) > now ? value : null;
  const retryAt = future(scheduler?.retryAt);
  const budgetResumeAt =
    scheduler?.resources
      .map((resource) => future(resource.resumeAt))
      .filter((value): value is string => value !== null)
      .sort()
      .at(0) ?? null;
  const base = {
    lastSyncedAt: snapshot.lastPolledAt,
    nextSyncAt,
    resumeAt: null,
    pending,
    message: null,
  } satisfies Omit<PrHubSyncState, "state">;
  const message = snapshot.errorMessage ?? null;

  if (snapshot.status === "auth_required") return { ...base, state: "auth_required", message };
  if (snapshot.status === "gh_missing") return { ...base, state: "error", message };
  if (retryAt && scheduler?.cooldownReason === "network")
    return { ...base, state: "offline", resumeAt: retryAt };
  if (retryAt && scheduler?.cooldownReason === "rate-limit")
    return { ...base, state: "rate_limited", resumeAt: retryAt };
  if (snapshot.status === "error" || snapshot.status === "degraded")
    return { ...base, state: "error", message };
  if (
    snapshot.lastPolledAt === null ||
    snapshot.errorKind === PR_HUB_BACKLOG_ERROR_KIND ||
    pending.searches + pending.hydrations > 0
  )
    return { ...base, state: "syncing", resumeAt: budgetResumeAt };
  return { ...base, state: "idle" };
}
