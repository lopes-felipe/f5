import type { PendingApproval, TimelineEntry } from "../../session-logic";
import {
  compareTimelineEntries,
  timelineEntriesStructure,
  setTimelineEntriesStructure,
} from "../../session-logic";

export function createTimelineApprovalCache() {
  return {
    source: undefined as object | undefined,
    keys: "",
    structure: {},
    rows: new Map<
      string,
      { source: TimelineEntry | undefined; approval: PendingApproval; row: TimelineEntry }
    >(),
  };
}

/** Pending requests survive work-log filters and lazy activity history. */
export function withTimelineApprovals(
  entries: readonly TimelineEntry[],
  approvals: readonly PendingApproval[],
  cache = createTimelineApprovalCache(),
  heldRequestIds: ReadonlySet<string> = new Set(),
): TimelineEntry[] {
  approvals = approvals.filter((approval) => !heldRequestIds.has(approval.requestId));
  if (!approvals.length) {
    cache.rows.clear();
    cache.source = undefined;
    cache.keys = "";
    return entries as TimelineEntry[];
  }
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
    const previous = cache.rows.get(row.id);
    if (previous?.source === row && previous.approval === approval) return previous.row;
    const result = { ...row, entry: { ...row.entry, pendingApproval: approval } };
    cache.rows.set(row.id, { source: row, approval, row: result });
    return result;
  });
  for (const approval of pending.values()) {
    const id = "pending-approval:" + approval.requestId;
    const previous = cache.rows.get(id);
    if (previous?.approval === approval) {
      rows.push(previous.row);
      continue;
    }
    const row: TimelineEntry = {
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
    };
    cache.rows.set(id, { source: undefined, approval, row });
    rows.push(row);
  }
  rows.sort(compareTimelineEntries);
  const source = timelineEntriesStructure(entries);
  const keys = JSON.stringify(
    approvals.map((approval) => [approval.requestId, approval.createdAt]),
  );
  if (!source || cache.source !== source || cache.keys !== keys) {
    cache.source = source;
    cache.keys = keys;
    cache.structure = {};
  }
  const ids = new Set(approvals.map((approval) => approval.requestId));
  for (const [id, previous] of cache.rows)
    if (!ids.has(previous.approval.requestId)) cache.rows.delete(id);
  setTimelineEntriesStructure(rows, cache.structure);
  return rows;
}
