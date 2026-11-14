import { describe, expect, it, vi } from "vitest";

import { openNotificationTarget, type NotificationNavigate } from "./openTarget";

function navigateSpy() {
  const navigate = vi.fn(async () => undefined);
  return { navigate, asNavigate: navigate as unknown as NotificationNavigate };
}

describe("openNotificationTarget", () => {
  it.each([
    [
      { kind: "thread", threadId: "t1" },
      { to: "/$threadId", params: { threadId: "t1" } },
    ],
    [{ kind: "prHub" }, { to: "/pull-requests", search: {} }],
    [
      { kind: "prHub", prKey: "o/r#1" },
      { to: "/pull-requests", search: { pr: "o/r#1" } },
    ],
    [
      { kind: "scheduled", taskId: "task-1" },
      { to: "/scheduled", search: { taskId: "task-1" } },
    ],
    [
      { kind: "upstream", projectId: "project-1" },
      { to: "/upstream", search: { project: "project-1" } },
    ],
    [
      { kind: "upstream", projectId: "project-1", view: "features" },
      {
        to: "/upstream",
        search: {
          project: "project-1",
          list: "inbox",
          lane: ["feature"],
          sort: "newest",
          all: true,
        },
      },
    ],
    [{ kind: "update" }, { to: "/settings", search: { category: "about" } }],
  ] as const)("routes %o", async (target, expected) => {
    const { navigate, asNavigate } = navigateSpy();
    await openNotificationTarget(asNavigate, target, { focus: false });
    expect(navigate).toHaveBeenCalledWith(expected);
  });

  it("does nothing for a notification without a target", async () => {
    const { navigate, asNavigate } = navigateSpy();
    await openNotificationTarget(asNavigate, { kind: "none" }, { focus: false });
    expect(navigate).not.toHaveBeenCalled();
  });
});
