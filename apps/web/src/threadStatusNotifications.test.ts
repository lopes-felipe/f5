import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { diffThreadStatusNotifications, threadNotificationIcon } from "./threadStatusNotifications";

describe("threadNotificationIcon", () => {
  it("gives a failure its own glyph", () => {
    const failed = threadNotificationIcon("failed");
    expect(failed).toMatch(/^data:image\/svg\+xml,/);
    expect(failed).not.toBe(threadNotificationIcon("completed"));
    expect(threadNotificationIcon("none")).toBeUndefined();
  });
});

describe("diffThreadStatusNotifications", () => {
  const threadId = ThreadId.makeUnsafe("thread-1");
  const currentThread = {
    threadId,
    threadTitle: "Investigate crash",
    projectName: "Repo",
    status: "working" as const,
  };

  it("seeds the first hydrated snapshot without emitting notifications", () => {
    expect(diffThreadStatusNotifications(null, [currentThread]).transitions).toEqual([]);
  });

  it("ignores unchanged snapshots", () => {
    expect(
      diffThreadStatusNotifications(new Map([[threadId, "working" as const]]), [currentThread])
        .transitions,
    ).toEqual([]);
  });

  it("emits once when a visible status changes to a different visible status", () => {
    expect(
      diffThreadStatusNotifications(new Map([[threadId, "working" as const]]), [
        { ...currentThread, status: "pending-approval" as const },
      ]).transitions,
    ).toMatchObject([{ threadId, previousStatus: "working", status: "pending-approval" }]);
  });

  it("ignores transitions back to none", () => {
    expect(
      diffThreadStatusNotifications(new Map([[threadId, "completed" as const]]), [
        { ...currentThread, status: "none" as const },
      ]).transitions,
    ).toEqual([]);
  });

  it("treats newly observed threads after hydration as transitions from none", () => {
    expect(
      diffThreadStatusNotifications(new Map(), [{ ...currentThread, status: "awaiting-input" }])
        .transitions,
    ).toMatchObject([{ threadId, previousStatus: "none", status: "awaiting-input" }]);
  });
});
