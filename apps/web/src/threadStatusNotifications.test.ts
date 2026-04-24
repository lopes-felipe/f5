import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  diffThreadStatusNotifications,
  showThreadStatusNotification,
  shouldDispatchThreadStatusNotification,
  type ThreadStatusNotificationInstance,
} from "./threadStatusNotifications";

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

describe("shouldDispatchThreadStatusNotification", () => {
  it("suppresses notifications while the app is focused", () => {
    expect(
      shouldDispatchThreadStatusNotification({
        enabled: true,
        permission: "granted",
        appFocused: true,
        status: "completed",
      }),
    ).toBe(false);
  });

  it("allows notifications while the app is hidden or unfocused", () => {
    expect(
      shouldDispatchThreadStatusNotification({
        enabled: true,
        permission: "granted",
        appFocused: false,
        status: "completed",
      }),
    ).toBe(true);
  });

  it("requires granted permission", () => {
    expect(
      shouldDispatchThreadStatusNotification({
        enabled: true,
        permission: "default",
        appFocused: false,
        status: "completed",
      }),
    ).toBe(false);
  });

  it("requires the setting to be enabled", () => {
    expect(
      shouldDispatchThreadStatusNotification({
        enabled: false,
        permission: "granted",
        appFocused: false,
        status: "completed",
      }),
    ).toBe(false);
  });
});

describe("showThreadStatusNotification", () => {
  it("focuses the window and navigates to the thread when clicked", () => {
    const focusWindow = vi.fn();
    const navigateToThread = vi.fn();
    let notification: MockNotification | null = null;

    class MockNotification implements ThreadStatusNotificationInstance {
      clickListener: ((event: Event) => void) | null = null;
      close = vi.fn();
      static lastInstance: MockNotification | null = null;

      constructor(
        public title: string,
        public options?: NotificationOptions,
      ) {
        MockNotification.lastInstance = this;
      }

      addEventListener(type: "click", listener: (event: Event) => void) {
        this.clickListener = listener;
      }
    }

    showThreadStatusNotification({
      NotificationConstructor: MockNotification,
      transition: {
        threadId: ThreadId.makeUnsafe("thread-click"),
        threadTitle: "Plan follow-up",
        projectName: "Repo",
        previousStatus: "working",
        status: "pending-approval",
      },
      focusWindow,
      navigateToThread,
    });

    notification = MockNotification.lastInstance;
    expect(notification).toBeTruthy();
    notification?.clickListener?.({} as Event);

    expect(notification?.close).toHaveBeenCalledTimes(1);
    expect(focusWindow).toHaveBeenCalledTimes(1);
    expect(navigateToThread).toHaveBeenCalledWith(ThreadId.makeUnsafe("thread-click"));
  });
});
