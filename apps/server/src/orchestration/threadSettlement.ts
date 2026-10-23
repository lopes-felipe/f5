import type { OrchestrationThread } from "@t3tools/contracts";

export interface SettlementPullRequest {
  readonly state: "open" | "closed" | "merged";
  readonly mergedAt?: string | null;
  readonly closedAt?: string | null;
}
export interface SettlementCandidate {
  readonly thread: OrchestrationThread;
  readonly hasQueuedWork?: boolean;
  readonly hasPendingRequest?: boolean;
  readonly hasBackgroundWork?: boolean;
  readonly hasWatch?: boolean;
}
const millis = (value: string | null | undefined) => {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
};
export function settlementActivityAt(thread: OrchestrationThread): string {
  return new Date(
    Math.max(
      ...[
        thread.createdAt,
        thread.lastInteractionAt,
        thread.latestTurn?.requestedAt,
        thread.latestTurn?.startedAt,
        thread.latestTurn?.completedAt,
      ]
        .map(millis)
        .filter((time): time is number => time !== null),
    ),
  ).toISOString();
}
export function isIdleSettlementCandidate(input: SettlementCandidate, nowMs: number): boolean {
  const thread = input.thread;
  return (
    !thread.deletedAt &&
    !thread.archivedAt &&
    !thread.settledAt &&
    !thread.pinnedAt &&
    (millis(thread.snoozedUntil) ?? -Infinity) <= nowMs &&
    !thread.session?.activeTurnId &&
    !["running", "starting"].includes(thread.session?.status ?? "") &&
    thread.latestTurn?.state !== "running" &&
    !(thread.latestTurn?.completedAt && thread.latestTurn.processingQuiescedAt === null) &&
    !thread.pendingUserInputs?.length &&
    !input.hasQueuedWork &&
    !input.hasPendingRequest &&
    !input.hasBackgroundWork
  );
}
export function isAutoSettlementCandidate(input: SettlementCandidate, nowMs: number): boolean {
  return (
    isIdleSettlementCandidate(input, nowMs) && !input.thread.autoSettleDisabled && !input.hasWatch
  );
}
/** The plan intentionally keeps closed-PR settlement behind the same opt-in as merged PRs. */
export function resolveAutoSettlementAt(
  input: SettlementCandidate & {
    readonly nowMs: number;
    readonly latestUserAuthoredMessageAt: string | null;
    readonly lastUnsettledAt?: string | null;
    readonly pullRequests: ReadonlyArray<SettlementPullRequest | null>;
    readonly autoSettleOnPullRequestMerge: boolean;
    readonly autoSettleAfterDays: number | null;
    readonly autoSettleKeepPullRequests: boolean;
  },
): string | null {
  if (!isAutoSettlementCandidate(input, input.nowMs)) return null;
  const activityAt = settlementActivityAt(input.thread);
  const userAnchor = Math.max(
    millis(input.thread.createdAt) ?? Infinity,
    millis(input.latestUserAuthoredMessageAt) ?? -Infinity,
    millis(input.lastUnsettledAt) ?? -Infinity,
  );
  if (
    input.autoSettleOnPullRequestMerge &&
    input.pullRequests.length > 0 &&
    input.pullRequests.every((pr) => pr && pr.state !== "open")
  ) {
    const terminal = input.pullRequests.map((pr) =>
      millis(pr?.state === "merged" ? pr.mergedAt : pr?.closedAt),
    );
    if (
      terminal.every((value) => value !== null) &&
      Math.max(...(terminal as number[])) >= userAnchor
    )
      return activityAt;
  }
  if (input.autoSettleKeepPullRequests && input.pullRequests.length) return null;
  if (
    input.autoSettleAfterDays === null ||
    !Number.isInteger(input.autoSettleAfterDays) ||
    input.autoSettleAfterDays < 1 ||
    input.autoSettleAfterDays > 365
  )
    return null;
  return input.nowMs - Date.parse(activityAt) >= input.autoSettleAfterDays * 86_400_000
    ? activityAt
    : null;
}
