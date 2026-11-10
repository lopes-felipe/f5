import { ApprovalRequestId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { toastDedupeKey } from "../components/ui/toast.logic";

const mocks = vi.hoisted(() => {
  let sequence = 0;
  return {
    add: vi.fn(() => `toast-${++sequence}`),
    close: vi.fn(),
    present: vi.fn(async () => true),
  };
});
vi.mock("../components/ui/toast", () => ({
  toastManager: { add: mocks.add, close: mocks.close },
}));
vi.mock("./osNotifications", () => ({ presentOsNotification: mocks.present }));

const {
  deliverErrorNotification,
  notify,
  registerNotificationRecorder,
  resetNotifyStateForTests,
  resolveThreadAttention,
  subscribeApprovalResolved,
} = await import("./notify");
const { DEFAULT_NOTIFICATION_PREFERENCES, DO_NOT_DISTURB_FOREVER } = await import("./preferences");
type DeliveryEnvironment = import("./notify").DeliveryEnvironment;

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const threadA = ThreadId.makeUnsafe("thread-a");

function env(overrides: Partial<DeliveryEnvironment> = {}): DeliveryEnvironment {
  return {
    preferences: DEFAULT_NOTIFICATION_PREFERENCES,
    doNotDisturbUntil: null,
    dndAllowUrgent: true,
    appFocused: true,
    activeThreadId: null,
    permission: "granted",
    nowMs: NOW,
    ...overrides,
  };
}

const threadInput = {
  source: "thread" as const,
  severity: "attention" as const,
  title: "Needs input",
  threadId: threadA,
  target: { kind: "thread" as const, threadId: threadA },
};
const threadPrefs = {
  ...DEFAULT_NOTIFICATION_PREFERENCES,
  thread: { inApp: true, system: true, sound: false },
};

beforeEach(() => {
  resetNotifyStateForTests();
  vi.clearAllMocks();
  mocks.present.mockImplementation(async () => true);
});
afterEach(() => resetNotifyStateForTests());

describe("notify", () => {
  it("shows a toast when the OS notification can't be shown", async () => {
    mocks.present.mockImplementation(async () => false);
    notify({ ...threadInput }, env({ appFocused: false, preferences: threadPrefs }));
    expect(mocks.add).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(mocks.add).toHaveBeenCalledTimes(1));
  });

  it("doesn't fall back to a toast when in-app delivery is off", async () => {
    mocks.present.mockImplementation(async () => false);
    const preferences = {
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      thread: { inApp: false, system: true, sound: false },
    };
    notify({ ...threadInput }, env({ appFocused: false, preferences }));
    await vi.waitFor(() => expect(mocks.present).toHaveBeenCalled());
    await Promise.resolve();
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("keeps OS notifications silent so only the app's sound policy plays audio", () => {
    notify({ ...threadInput }, env({ appFocused: false, preferences: threadPrefs }));
    expect(mocks.present).toHaveBeenCalledWith(
      expect.objectContaining({ silent: true }),
      expect.anything(),
    );
  });

  it("records a notification about the thread on screen as read", () => {
    const recorded: Array<{ read: boolean }> = [];
    const unregister = registerNotificationRecorder((input) => recorded.push(input));
    notify({ ...threadInput }, env({ activeThreadId: threadA }));
    notify({ ...threadInput }, env({ activeThreadId: threadA, appFocused: false }));
    notify({ ...threadInput }, env());
    unregister();
    expect(recorded.map((input) => input.read)).toEqual([true, false, false]);
  });

  it("closes an urgent toast without inline buttons once the thread stops waiting", () => {
    notify({ ...threadInput, urgent: true }, env({ preferences: threadPrefs }));
    const toastId = mocks.add.mock.results[0]!.value as string;
    resolveThreadAttention(threadA);
    expect(mocks.close).toHaveBeenCalledWith(toastId);
  });

  it("retires an approval toast as Answered and replaces an older urgent toast", () => {
    const resolved: string[] = [];
    const unsubscribe = subscribeApprovalResolved((_approval, label) => resolved.push(label));
    const approval = {
      threadId: threadA,
      requestId: ApprovalRequestId.makeUnsafe("request-1"),
      requestKind: "command" as const,
    };
    notify({ ...threadInput, urgent: true }, env({ preferences: threadPrefs }));
    const first = mocks.add.mock.results[0]!.value as string;
    notify({ ...threadInput, urgent: true, approval }, env({ preferences: threadPrefs }));
    expect(mocks.close).toHaveBeenCalledWith(first);
    resolveThreadAttention(threadA);
    unsubscribe();
    expect(resolved).toEqual(["Answered"]);
  });
});

describe("deliverErrorNotification", () => {
  it("records every error and shows the toast by default", () => {
    const recorded: string[] = [];
    const unregister = registerNotificationRecorder((input) => recorded.push(input.source));
    expect(deliverErrorNotification({ title: "Push failed" }, env())).toBe(true);
    unregister();
    expect(recorded).toEqual(["errors"]);
  });

  it("follows the Errors switches and Do Not Disturb", () => {
    const off = {
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      errors: { inApp: false, system: false, sound: false },
    };
    expect(deliverErrorNotification({ title: "Push failed" }, env({ preferences: off }))).toBe(
      false,
    );
    expect(
      deliverErrorNotification(
        { title: "Push failed" },
        env({ doNotDisturbUntil: DO_NOT_DISTURB_FOREVER }),
      ),
    ).toBe(false);
  });

  it("uses the OS for errors in the background when asked, and keeps the toast for return", () => {
    const system = {
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      errors: { inApp: true, system: true, sound: false },
    };
    expect(
      deliverErrorNotification(
        { title: "Push failed" },
        env({ appFocused: false, preferences: system }),
      ),
    ).toBe(true);
    expect(mocks.present).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Push failed", silent: true }),
      expect.anything(),
    );
  });
});

describe("toastDedupeKey", () => {
  it("doesn't merge toasts whose buttons act on their own payload", () => {
    const base = { type: "info", title: "Linked prompt ready" };
    expect(toastDedupeKey(base)).not.toBe(null);
    expect(toastDedupeKey({ ...base, actionProps: { children: "Replace draft" } })).toBe(null);
    expect(toastDedupeKey({ ...base, data: { actions: [{ label: "Replace draft" }] } })).toBe(null);
    expect(
      toastDedupeKey({ ...base, data: { dedupeKey: "k", actions: [{ label: "Open" }] } }),
    ).toBe("k");
  });
});
