import { ProviderInstanceId, ScheduledTaskId, ScheduledTaskRunId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { updateAppSettings } from "~/appSettings";
import { DEFAULT_SNOOZE_PRESETS, resolveSnoozePresets } from "~/lib/snoozePresets";
import {
  buildThreadActionMenuItems,
  canScheduleIntoThread,
  nativeThreadActionMenuItems,
  resolveSnoozeMenuPresets,
  settlementErrorDetail,
} from "./useThreadActionController";

describe("settlementErrorDetail", () => {
  it("shows the server's reason a settle was refused", () => {
    const pretty =
      "OrchestrationCommandInvariantError: Orchestration command invariant failed (thread.settle): This thread has a queued message. Send it or remove it from the queue before settling.\n    at decide (decider.ts:1:1)";
    expect(settlementErrorDetail(new Error(pretty))).toBe(
      "This thread has a queued message. Send it or remove it from the queue before settling.",
    );
    expect(settlementErrorDetail(new Error("socket closed"))).toBe(
      "Check pending work on the thread, then retry.",
    );
  });
});

describe("buildThreadActionMenuItems", () => {
  it("adapts active thread actions to pin and snooze state", () => {
    const active = buildThreadActionMenuItems({
      thread: { archivedAt: null, titleRegeneration: null },
      pinned: false,
      snoozed: false,
    });
    expect(active.map((item) => item.id)).toEqual([
      "rename",
      "regenerate-title",
      "pin",
      "snooze:after:180",
      "snooze:at:tomorrow:09:00",
      "snooze:at:next-week:09:00",
      "settle",
      "archive",
      "mark-unread",
      "copy-path",
      "copy-thread-id",
      "delete",
    ]);

    const snoozed = buildThreadActionMenuItems({
      thread: { archivedAt: null, titleRegeneration: null },
      pinned: false,
      snoozed: true,
    });
    expect(snoozed.some((item) => item.id === "wake")).toBe(true);
    expect(snoozed.some((item) => item.id.startsWith("snooze:"))).toBe(false);
  });

  it("lists the configured snooze options with their wake times", () => {
    const items = buildThreadActionMenuItems({
      thread: { archivedAt: null, titleRegeneration: null },
      pinned: false,
      snoozed: false,
      snoozePresets: [
        {
          id: "after:30",
          label: "In 30 minutes",
          whenLabel: "10:30",
          snoozedUntil: "2026-10-28T10:30:00.000Z",
        },
      ],
    });
    expect(items.filter((item) => item.id.startsWith("snooze:"))).toEqual([
      { id: "snooze:after:30", label: "Snooze: In 30 minutes (10:30)" },
    ]);
  });

  it("offers an explicit wake and keeps pinned or snoozed work out of manual settlement", () => {
    for (const state of [
      { pinned: true, snoozed: false },
      { pinned: false, snoozed: true },
    ]) {
      expect(
        buildThreadActionMenuItems({
          thread: { archivedAt: null, titleRegeneration: null },
          ...state,
        }).find((item) => item.id === "settle")?.disabled,
      ).toBe(true);
    }
    const settled = buildThreadActionMenuItems({
      thread: { archivedAt: null, titleRegeneration: null, settledAt: "2026-10-19T12:00:00.000Z" },
      pinned: false,
      snoozed: false,
    });
    expect(settled.find((item) => item.id === "unsettle")?.disabled).not.toBe(true);
    expect(settled.some((item) => item.id === "settle")).toBe(false);
  });

  it("preserves unavailable actions as disabled in native menus", () => {
    const items = buildThreadActionMenuItems({
      thread: {
        archivedAt: "2026-08-15T00:00:00.000Z",
        titleRegeneration: {
          requestId: "command-1" as never,
          startedAt: "2026-08-15T00:00:00.000Z",
        },
      },
      pinned: false,
      snoozed: false,
    });
    expect(items.find((item) => item.id === "title-regeneration-pending")?.disabled).toBe(true);
    expect(items.some((item) => item.id === "unarchive")).toBe(true);
    expect(items.some((item) => item.id === "pin")).toBe(false);
    expect(nativeThreadActionMenuItems(items)).toContainEqual(
      expect.objectContaining({ disabled: true }),
    );
  });
});

describe("scheduled thread actions", () => {
  const thread = {
    archivedAt: null,
    titleRegeneration: null,
    scheduledOrigin: {
      taskId: ScheduledTaskId.makeUnsafe("task"),
      runId: ScheduledTaskRunId.makeUnsafe("run"),
    },
  };
  it("identifies the source independently of the thread title and offers direct editing", () => {
    const items = buildThreadActionMenuItems({
      thread,
      pinned: false,
      snoozed: false,
      schedule: { state: "available", name: "Daily check" },
    });
    expect(items.slice(0, 3)).toEqual([
      { id: "scheduled-origin", label: "Scheduled task: Daily check", disabled: true },
      { id: "edit-schedule", label: "Edit scheduled task…" },
      { id: "rename", label: "Rename thread", separatorBefore: true },
    ]);
    expect(nativeThreadActionMenuItems(items).slice(0, 3)).toEqual(items.slice(0, 3));
  });
  it("distinguishes removed schedules from failed lookups without offering invalid editing", () => {
    for (const [state, label] of [
      ["removed", "Scheduled task removed"],
      ["unavailable", "Scheduled task unavailable"],
    ] as const) {
      const items = buildThreadActionMenuItems({
        thread,
        pinned: false,
        snoozed: false,
        schedule: { state },
      });
      expect(items[0]).toEqual({ id: "scheduled-origin", label, disabled: true });
      expect(items.some((item) => item.id === "edit-schedule")).toBe(false);
      expect(items.some((item) => item.id === "rename")).toBe(true);
    }
  });
  it("offers scheduling into active, unscheduled conversations only", () => {
    const ids = (overrides: Partial<Parameters<typeof buildThreadActionMenuItems>[0]["thread"]>) =>
      buildThreadActionMenuItems({
        thread: { ...thread, scheduledOrigin: null, ...overrides },
        pinned: false,
        snoozed: false,
        canScheduleInConversation: true,
      }).map((item) => item.id);
    expect(ids({}).slice(0, 3)).toEqual(["rename", "regenerate-title", "schedule-in-conversation"]);
    expect(ids({ archivedAt: "2026-01-01T00:00:00Z" })).not.toContain("schedule-in-conversation");
    expect(ids({ scheduledOrigin: thread.scheduledOrigin })).not.toContain(
      "schedule-in-conversation",
    );
    expect(
      buildThreadActionMenuItems({
        thread: { ...thread, scheduledOrigin: null },
        pinned: false,
        snoozed: false,
      }).map((item) => item.id),
    ).not.toContain("schedule-in-conversation");
  });
  it("offers scheduling only for server conversations that have sent a message", () => {
    expect(canScheduleIntoThread(undefined)).toBe(false);
    expect(canScheduleIntoThread({ modelSelection: undefined })).toBe(false);
    expect(
      canScheduleIntoThread({
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      }),
    ).toBe(true);
  });
});

describe("resolveSnoozeMenuPresets", () => {
  afterEach(() => updateAppSettings({ snoozePresets: [...DEFAULT_SNOOZE_PRESETS] }));

  it("keeps snooze in menus when no option is left", () => {
    const now = new Date(2026, 9, 28, 20);
    const defaults = resolveSnoozePresets(DEFAULT_SNOOZE_PRESETS, now).map((preset) => preset.id);
    updateAppSettings({ snoozePresets: [] });
    expect(resolveSnoozeMenuPresets(now).map((preset) => preset.id)).toEqual(defaults);
    // Only a time today that has already passed.
    updateAppSettings({ snoozePresets: [{ kind: "at", day: "today", time: "17:00" }] });
    expect(resolveSnoozeMenuPresets(now).map((preset) => preset.id)).toEqual(defaults);
    updateAppSettings({ snoozePresets: [{ kind: "at", day: "today", time: "21:00" }] });
    expect(resolveSnoozeMenuPresets(now).map((preset) => preset.id)).toEqual(["at:today:21:00"]);
  });
});
