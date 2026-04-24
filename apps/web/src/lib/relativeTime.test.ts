import { describe, expect, it, vi } from "vitest";

import { formatAbsoluteTimeLabel, formatRelativeTimeLabel } from "./relativeTime";

describe("formatRelativeTimeLabel", () => {
  it("formats recent timestamps across the supported ranges", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-25T12:00:00.000Z"));

    try {
      expect(formatRelativeTimeLabel("2026-03-25T11:59:30.000Z")).toBe("just now");
      expect(formatRelativeTimeLabel("2026-03-25T11:55:00.000Z")).toBe("5m ago");
      expect(formatRelativeTimeLabel("2026-03-25T09:00:00.000Z")).toBe("3h ago");
      expect(formatRelativeTimeLabel("2026-03-20T12:00:00.000Z")).toBe("5d ago");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns an empty label for invalid timestamps", () => {
    expect(formatRelativeTimeLabel("")).toBe("");
    expect(formatRelativeTimeLabel("not-an-iso-timestamp")).toBe("");
  });
});

describe("formatAbsoluteTimeLabel", () => {
  it("returns a locale-formatted date-time for valid timestamps", () => {
    const label = formatAbsoluteTimeLabel("2026-03-25T12:00:00.000Z");
    expect(label).not.toBe("");
    // Year should always be present regardless of locale.
    expect(label).toMatch(/2026/);
  });

  it("returns an empty label for invalid timestamps", () => {
    expect(formatAbsoluteTimeLabel("")).toBe("");
    expect(formatAbsoluteTimeLabel("not-an-iso-timestamp")).toBe("");
  });
});
