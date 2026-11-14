import { expect, it } from "vitest";
import {
  pendingActivityWindow,
  pendingApprovalActivities,
} from "@t3tools/shared/pendingActivityWindow";

it("keeps older approvals answerable without reducing the normal window", () => {
  const approval = { kind: "approval.requested", payload: { requestId: "old" } };
  const activity = { kind: "tool.updated" };
  expect(pendingActivityWindow([approval, activity, activity], 1)).toEqual([
    approval,
    activity,
    activity,
  ]);
  expect(
    pendingActivityWindow(
      [approval, { kind: "approval.resolved", payload: { requestId: "old" } }, activity],
      1,
    ),
  ).toEqual([activity]);
});
it("uses the same closing rule for failed answers and retention", () => {
  const request = { kind: "approval.requested", payload: { requestId: "old" } };
  const failure = { kind: "provider.approval.respond.failed", payload: { requestId: "old" } };
  const later = { kind: "tool.updated" };
  expect(pendingApprovalActivities([request, failure, later])).toEqual([]);
  expect(pendingActivityWindow([request, failure, later], 1)).toEqual([later]);
});
