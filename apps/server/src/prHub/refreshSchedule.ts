import type { PrHubSchedulerState, PrHubSnapshot } from "@t3tools/contracts";

/** Shared by admission, background wakeups and the dashboard; this only schedules reads. */
export function nextPrHubRefreshAt(
  snapshot: PrHubSnapshot,
  intervalSeconds: number,
  scheduler: PrHubSchedulerState,
  now = Date.now(),
): string | null {
  if (intervalSeconds === 0) return null;
  const lastAttempt = snapshot.lastPolledAt ? Date.parse(snapshot.lastPolledAt) : now;
  const pending =
    snapshot.status === "degraded" ||
    snapshot.status === "error" ||
    snapshot.coverage?.some((scope) => (scope.remainingTasks ?? 0) > 0);
  const graphql = scheduler.resources.find((resource) => resource.resource === "graphql");
  const search = scheduler.resources.find((resource) => resource.resource === "search");
  const recovering = snapshot.coverage?.some(
    (scope) => scope.scope === "previously_tracked" && (scope.remainingTasks ?? 0) > 0,
  );
  const resourceRetry = recovering
    ? graphql?.resumeAt
    : [graphql?.resumeAt, search?.resumeAt]
        .filter((value): value is string => !!value)
        .sort()
        .at(-1);
  const retry = Math.max(
    scheduler.retryAt ? Date.parse(scheduler.retryAt) : 0,
    resourceRetry ? Date.parse(resourceRetry) : 0,
  );
  const ordinary = lastAttempt + Math.max(60, intervalSeconds) * 1000;
  // A known admission deadline can wake recovery sooner than the ordinary poll.
  // Unknown/transient failures and application-level hydration budgets get a bounded recheck.
  const recorded = snapshot.nextRefreshAt ? Date.parse(snapshot.nextRefreshAt) : 0;
  const deadline = pending
    ? recorded > lastAttempt
      ? recorded
      : retry > now
        ? retry
        : lastAttempt + 60_000
    : ordinary;
  return new Date(Math.max(now, deadline, retry)).toISOString();
}
