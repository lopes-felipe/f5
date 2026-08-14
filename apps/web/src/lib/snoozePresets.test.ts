import { describe, expect, it } from "vitest";

import { resolveSnoozePreset } from "./snoozePresets";

describe("resolveSnoozePreset", () => {
  it("resolves the duration and local-calendar presets", () => {
    const now = new Date("2026-08-15T10:30:00.000Z");
    expect(resolveSnoozePreset("three-hours", now)).toBe("2026-08-15T13:30:00.000Z");

    const tomorrow = new Date(resolveSnoozePreset("tomorrow-morning", now));
    expect(tomorrow.getDate()).toBe(new Date(now).getDate() + 1);
    expect(tomorrow.getHours()).toBe(9);
    expect(tomorrow.getMinutes()).toBe(0);

    const nextWeek = new Date(resolveSnoozePreset("next-week", now));
    expect(nextWeek.getTime()).toBeGreaterThan(now.getTime() + 6 * 24 * 60 * 60 * 1_000);
    expect(nextWeek.getHours()).toBe(9);
  });
});
