import type { DesktopNotificationsBridge } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import type { AppNotificationInstance } from "../notifications";
import { selectActivationTarget } from "./NotificationActivationRouter";
import { presentOsNotification } from "./osNotifications";

function bridge(show: DesktopNotificationsBridge["show"]): DesktopNotificationsBridge {
  return {
    show,
    takeActivations: vi.fn(async () => []),
    onActivationsAvailable: vi.fn(() => () => undefined),
  };
}

class MockNotification implements AppNotificationInstance {
  static last: MockNotification | null = null;
  click: ((event: Event) => void) | null = null;
  close = vi.fn();
  constructor(
    readonly title: string,
    readonly options?: NotificationOptions,
  ) {
    MockNotification.last = this;
  }
  addEventListener(_type: "click", listener: (event: Event) => void) {
    this.click = listener;
  }
}

const input = {
  id: "n1",
  title: "Completed",
  body: "Repo · Thread",
  tag: "thread-1",
  icon: "data:image/svg+xml,x",
  target: { kind: "thread", threadId: "thread-1" },
} as const;

describe("presentOsNotification", () => {
  it("hands the notification to the desktop main process when it can", async () => {
    const show = vi.fn(async () => true);
    const onActivate = vi.fn();
    MockNotification.last = null;
    await expect(
      presentOsNotification(input, {
        bridge: bridge(show),
        NotificationConstructor: MockNotification,
        onActivate,
      }),
    ).resolves.toBe(true);
    expect(show).toHaveBeenCalledWith({
      id: "n1",
      title: "Completed",
      body: "Repo · Thread",
      tag: "thread-1",
      target: input.target,
    });
    expect(MockNotification.last).toBe(null);
  });

  it("falls back to a browser notification that opens the target on click", async () => {
    const onActivate = vi.fn();
    await expect(
      presentOsNotification(input, {
        bridge: bridge(async () => false),
        NotificationConstructor: MockNotification,
        onActivate,
      }),
    ).resolves.toBe(true);
    const notification = MockNotification.last!;
    expect(notification.options?.tag).toBe("thread-1");
    notification.click?.({} as Event);
    expect(notification.close).toHaveBeenCalled();
    expect(onActivate).toHaveBeenCalledWith(input.target);
  });

  it("falls back to a browser notification when the desktop handler throws", async () => {
    const onActivate = vi.fn();
    MockNotification.last = null;
    await expect(
      presentOsNotification(input, {
        bridge: bridge(async () => Promise.reject(new Error("Invalid notification."))),
        NotificationConstructor: MockNotification,
        onActivate,
      }),
    ).resolves.toBe(true);
    expect(MockNotification.last).not.toBe(null);
  });

  it("sends the desktop icon as a PNG and skips it when none can be made", async () => {
    const show = vi.fn(async () => true);
    await presentOsNotification(input, {
      bridge: bridge(show),
      NotificationConstructor: null,
      onActivate: vi.fn(),
      desktopIcon: async () => "data:image/png;base64,AAAA",
    });
    expect(show).toHaveBeenLastCalledWith(
      expect.objectContaining({ icon: "data:image/png;base64,AAAA" }),
    );
    await presentOsNotification(input, {
      bridge: bridge(show),
      NotificationConstructor: null,
      onActivate: vi.fn(),
      desktopIcon: async () => Promise.reject(new Error("decode failed")),
    });
    expect(show).toHaveBeenLastCalledWith(expect.not.objectContaining({ icon: expect.anything() }));
  });

  it("reports nothing shown without any presenter", async () => {
    await expect(
      presentOsNotification(input, {
        bridge: null,
        NotificationConstructor: null,
        onActivate: vi.fn(),
      }),
    ).resolves.toBe(false);
  });
});

describe("selectActivationTarget", () => {
  it("opens the last clicked target that goes somewhere", () => {
    expect(
      selectActivationTarget([
        { id: "a", target: { kind: "thread", threadId: "t1" } },
        { id: "b", target: { kind: "prHub", prKey: "o/r#1" } },
        { id: "c", target: { kind: "none" } },
      ]),
    ).toEqual({ kind: "prHub", prKey: "o/r#1" });
    expect(selectActivationTarget([{ id: "c", target: { kind: "none" } }])).toBe(null);
  });
});
