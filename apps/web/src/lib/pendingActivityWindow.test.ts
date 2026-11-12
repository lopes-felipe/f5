import { expect, it } from "vitest";
import { pendingActivityWindow } from "@t3tools/shared/pendingActivityWindow";

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
