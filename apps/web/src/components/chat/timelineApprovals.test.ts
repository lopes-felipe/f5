import { expect, it } from "vitest";
import { ApprovalRequestId } from "@t3tools/contracts";
import type { PendingApproval, TimelineEntry } from "../../session-logic";
import { withTimelineApprovals, createTimelineApprovalCache } from "./timelineApprovals";
import { setTimelineEntriesStructure, timelineEntriesStructure } from "../../session-logic";

const approval: PendingApproval = {
  requestId: ApprovalRequestId.make("approval"),
  requestKind: "command",
  createdAt: "2026-11-20T00:00:01Z",
  detail: "echo hello\nsecond command",
};
it("keeps a request visible when filters or lazy history omitted its activity", () => {
  const rows = withTimelineApprovals([], [approval]);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: "work", entry: { pendingApproval: approval } });
});
it("replaces the request row without duplicating it or attaching controls to the tool row", () => {
  const entries: TimelineEntry[] = [
    {
      kind: "work",
      id: "tool",
      createdAt: approval.createdAt,
      entry: {
        id: "tool",
        createdAt: approval.createdAt,
        tone: "tool",
        label: "Run command",
      },
    },
    {
      kind: "work",
      id: "request",
      createdAt: approval.createdAt,
      entry: {
        id: "request",
        createdAt: approval.createdAt,
        tone: "info",
        label: "Approval requested",
        activityKind: "approval.requested",
        requestId: approval.requestId,
      },
    },
  ];
  expect(withTimelineApprovals(entries, [approval])).toHaveLength(2);
  expect(
    withTimelineApprovals(entries, [approval]).find((row) => row.id === "request"),
  ).toMatchObject({
    entry: { pendingApproval: approval },
  });
  expect(withTimelineApprovals(entries, [])).toBe(entries);
});
it("never paints held requests as answerable", () => {
  expect(
    withTimelineApprovals(
      [],
      [approval],
      createTimelineApprovalCache(),
      new Set([approval.requestId]),
    ),
  ).toEqual([]);
});
it("retains structure identity and unchanged approval rows during content updates", () => {
  const source = {};
  const cache = createTimelineApprovalCache();
  const entries: TimelineEntry[] = [];
  setTimelineEntriesStructure(entries, source);
  const first = withTimelineApprovals(entries, [approval], cache);
  const next: TimelineEntry[] = [];
  setTimelineEntriesStructure(next, source);
  const second = withTimelineApprovals(next, [approval], cache);
  expect(timelineEntriesStructure(second)).toBe(timelineEntriesStructure(first));
  expect(second[0]).toBe(first[0]);
});
