import type { PendingApproval, TimelineEntry } from "../../session-logic";

/** Pending requests survive work-log filters and lazy activity history. */
export function withTimelineApprovals(
  entries: readonly TimelineEntry[],
  approvals: readonly PendingApproval[],
): TimelineEntry[] {
  if (!approvals.length) return entries as TimelineEntry[];
  const pending = new Map(approvals.map((approval) => [String(approval.requestId), approval]));
  const rows = entries.map((row): TimelineEntry => {
    if (
      row.kind !== "work" ||
      row.entry.activityKind !== "approval.requested" ||
      !row.entry.requestId
    )
      return row;
    const approval = pending.get(row.entry.requestId);
    if (!approval) return row;
    pending.delete(row.entry.requestId);
    return { ...row, entry: { ...row.entry, pendingApproval: approval } };
  });
  for (const approval of pending.values())
    rows.push({
      kind: "work",
      id: "pending-approval:" + approval.requestId,
      createdAt: approval.createdAt,
      entry: {
        id: "pending-approval:" + approval.requestId,
        createdAt: approval.createdAt,
        label: "Waiting for approval",
        tone: "info",
        pendingApproval: approval,
      },
    });
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
