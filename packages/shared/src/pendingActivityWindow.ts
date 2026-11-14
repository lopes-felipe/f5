/** Pending approvals are control state and must survive the history window. */
export function compareActivities(
  a: { sequence?: number | undefined; createdAt: string; id: string },
  b: { sequence?: number | undefined; createdAt: string; id: string },
): number {
  if ((a.sequence === undefined) !== (b.sequence === undefined))
    return a.sequence === undefined ? -1 : 1;
  return (
    (a.sequence ?? 0) - (b.sequence ?? 0) ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.id.localeCompare(b.id)
  );
}

export function isApprovalClosingActivity(activity: { kind: string }): boolean {
  return (
    activity.kind === "approval.resolved" ||
    activity.kind === "approval.response-submitted" ||
    activity.kind === "provider.approval.respond.failed"
  );
}

export function pendingApprovalActivities<A extends { kind: string; payload?: unknown }>(
  activities: ReadonlyArray<A>,
): A[] {
  const pending = new Map<string, A>();
  for (const activity of activities) {
    const payload = activity.payload as { requestId?: unknown } | null | undefined;
    if (typeof payload?.requestId !== "string") continue;
    if (activity.kind === "approval.requested") pending.set(payload.requestId, activity);
    else if (isApprovalClosingActivity(activity)) pending.delete(payload.requestId);
  }
  return [...pending.values()];
}

export function pendingActivityWindow<A extends { kind: string; payload?: unknown }>(
  activities: ReadonlyArray<A>,
  limit: number,
): A[] {
  const retained = new Set([...activities.slice(-limit), ...pendingApprovalActivities(activities)]);
  return activities.filter((activity) => retained.has(activity));
}
