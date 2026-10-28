import type { OrchestrationThread } from "@t3tools/contracts";

/** Replay approval activity in sequence order so all consumers agree on what is open. */
export function pendingApprovalActivities(thread: Pick<OrchestrationThread, "activities">) {
  const open = new Map<string, OrchestrationThread["activities"][number]>();
  for (const activity of [...thread.activities].toSorted(
    (a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.createdAt.localeCompare(b.createdAt),
  )) {
    const payload = activity.payload;
    const requestId =
      payload &&
      typeof payload === "object" &&
      "requestId" in payload &&
      typeof payload.requestId === "string"
        ? payload.requestId
        : null;
    if (!requestId) continue;
    if (activity.kind === "approval.requested") open.set(requestId, activity);
    else if (activity.kind === "approval.resolved") open.delete(requestId);
  }
  return [...open.values()];
}
