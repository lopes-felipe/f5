import { describe, expect, it } from "vitest";

import { parseMinIdleHours, parseRetentionDays } from "./WorktreeCleanupRulesEditor";

describe("parseMinIdleHours", () => {
  it("accepts whole hours from 1 to 720", () => {
    expect(parseMinIdleHours("1")).toBe(1);
    expect(parseMinIdleHours(" 24 ")).toBe(24);
    expect(parseMinIdleHours("720")).toBe(720);
  });

  it("rejects empty, zero, fractions and values past 30 days", () => {
    for (const value of ["", "  ", "0", "721", "1.5", "-3", "6h"]) {
      expect(parseMinIdleHours(value)).toBe("invalid");
    }
  });
});

describe("parseRetentionDays", () => {
  it("treats an empty field as never and accepts whole days from 1 to 3650", () => {
    expect(parseRetentionDays("")).toBeNull();
    expect(parseRetentionDays("  ")).toBeNull();
    expect(parseRetentionDays("1")).toBe(1);
    expect(parseRetentionDays(" 30 ")).toBe(30);
    expect(parseRetentionDays("3650")).toBe(3650);
  });

  it("rejects zero, fractions, negatives and values past ten years", () => {
    for (const value of ["0", "1.5", "-3", "3651", "7d", "1e3"]) {
      expect(parseRetentionDays(value)).toBe("invalid");
    }
  });
});
