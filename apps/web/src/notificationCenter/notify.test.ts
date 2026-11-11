import { ThreadId, ApprovalRequestId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { PendingApproval } from "../session-logic";
import { selectInlineApproval } from "./inlineApproval";
import { planNotificationDelivery, type DeliveryEnvironment } from "./notify";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  deriveNotificationPreferences,
  isDoNotDisturbActive,
  normalizeNotificationPreferences,
} from "./preferences";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const threadA = ThreadId.makeUnsafe("thread-a");
const threadB = ThreadId.makeUnsafe("thread-b");

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

describe("planNotificationDelivery", () => {
  it("toasts while focused and uses the OS while not", () => {
    expect(planNotificationDelivery({ source: "pr" }, env())).toEqual({
      record: true,
      toast: true,
      os: false,
      sound: false,
    });
    expect(planNotificationDelivery({ source: "pr" }, env({ appFocused: false }))).toEqual({
      record: true,
      toast: false,
      os: true,
      sound: false,
    });
  });

  it("leaves a toast waiting when the OS cannot show it", () => {
    expect(
      planNotificationDelivery({ source: "pr" }, env({ appFocused: false, permission: "denied" })),
    ).toMatchObject({ toast: true, os: false });
  });

  it("follows each source's switches", () => {
    const preferences = {
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      upstream: { inApp: false, system: false, sound: true },
    };
    expect(planNotificationDelivery({ source: "upstream" }, env({ preferences }))).toMatchObject({
      toast: false,
    });
    expect(
      planNotificationDelivery({ source: "upstream" }, env({ preferences, appFocused: false })),
    ).toEqual({ record: true, toast: false, os: false, sound: true });
  });

  it("keeps the thread on screen out of the toast stack", () => {
    const preferences = {
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      thread: { inApp: true, system: true, sound: false },
    };
    expect(
      planNotificationDelivery(
        { source: "thread", threadId: threadA },
        env({ preferences, activeThreadId: threadA }),
      ).toast,
    ).toBe(false);
    expect(
      planNotificationDelivery(
        { source: "thread", threadId: threadB },
        env({ preferences, activeThreadId: threadA }),
      ).toast,
    ).toBe(true);
  });

  it("holds everything but the record during Do Not Disturb, except allowed urgent items", () => {
    const dnd = env({ doNotDisturbUntil: "forever", appFocused: false });
    expect(planNotificationDelivery({ source: "pr" }, dnd)).toEqual({
      record: true,
      toast: false,
      os: false,
      sound: false,
    });
    expect(planNotificationDelivery({ source: "pr", urgent: true }, dnd).os).toBe(true);
    expect(
      planNotificationDelivery({ source: "pr", urgent: true }, { ...dnd, dndAllowUrgent: false })
        .os,
    ).toBe(false);
  });

  it("ends Do Not Disturb when its time passes", () => {
    expect(isDoNotDisturbActive("2026-11-10T13:00:00.000Z", NOW)).toBe(true);
    expect(isDoNotDisturbActive("2026-11-10T11:00:00.000Z", NOW)).toBe(false);
    expect(isDoNotDisturbActive(null, NOW)).toBe(false);
    expect(isDoNotDisturbActive("forever", NOW)).toBe(true);
  });
});

describe("notification preferences migration", () => {
  it("carries the old switches over", () => {
    expect(
      deriveNotificationPreferences({
        notificationMode: "system-and-sound",
        inAppThreadNotifications: true,
        enablePrAttentionNotifications: false,
      }),
    ).toMatchObject({
      thread: { inApp: true, system: true, sound: true },
      pr: { inApp: true, system: false, sound: false },
      scheduled: { inApp: true, system: true },
    });
    expect(
      deriveNotificationPreferences({ enableThreadStatusNotifications: false }).thread,
    ).toEqual({ inApp: false, system: false, sound: false });
    expect(deriveNotificationPreferences({}).thread).toEqual({
      inApp: false,
      system: true,
      sound: false,
    });
  });

  it("keeps good sources when one stored source is malformed", () => {
    const normalized = normalizeNotificationPreferences({
      pr: { inApp: false, system: "yes", sound: true },
      errors: null,
    });
    expect(normalized?.pr).toEqual({ inApp: false, system: true, sound: true });
    expect(normalized?.errors).toEqual(DEFAULT_NOTIFICATION_PREFERENCES.errors);
    expect(normalizeNotificationPreferences(undefined)).toBe(null);
  });
});

describe("selectInlineApproval", () => {
  const approval = (overrides: Partial<PendingApproval> = {}): PendingApproval => ({
    requestId: ApprovalRequestId.makeUnsafe("request"),
    requestKind: "command",
    createdAt: "2026-11-10T12:00:00.000Z",
    detail: "bun install",
    ...overrides,
  });

  it("offers a single command or file approval inline", () => {
    expect(selectInlineApproval(threadA, [approval()])).toMatchObject({
      threadId: threadA,
      requestKind: "command",
      detail: "bun install",
    });
    expect(selectInlineApproval(threadA, [approval({ requestKind: "file-change" })])).not.toBe(
      null,
    );
    expect(
      selectInlineApproval(threadA, [
        approval({
          approvalOptions: [
            { decision: "accept", label: "Yes" },
            { decision: "decline", label: "No" },
          ],
        }),
      ]),
    ).not.toBe(null);
  });

  it("opens the thread for anything richer", () => {
    expect(selectInlineApproval(threadA, [])).toBe(null);
    expect(selectInlineApproval(threadA, [approval(), approval()])).toBe(null);
    expect(selectInlineApproval(threadA, [approval({ requestKind: "permission" })])).toBe(null);
    expect(selectInlineApproval(threadA, [approval({ requestKind: "mcp-elicitation" })])).toBe(
      null,
    );
    expect(
      selectInlineApproval(threadA, [
        approval({ approvalOptions: [{ decision: "acceptForSession", label: "Session" }] }),
      ]),
    ).toBe(null);
  });
});
