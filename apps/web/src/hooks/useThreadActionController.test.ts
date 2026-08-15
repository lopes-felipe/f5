import { describe, expect, it } from "vitest";

import {
  buildThreadActionMenuItems,
  nativeThreadActionMenuItems,
} from "./useThreadActionController";

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
      "snooze-three-hours",
      "snooze-tomorrow",
      "snooze-next-week",
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
    expect(snoozed.some((item) => item.id.startsWith("snooze-"))).toBe(false);
  });

  it("disables pending regeneration and strips web-only fields for native menus", () => {
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
    expect(nativeThreadActionMenuItems(items)).not.toContainEqual(
      expect.objectContaining({ disabled: true }),
    );
  });
});
