import { describe, expect, it } from "vitest";

import { parseRetentionDays } from "./WorktreeCleanupRulesEditor";

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
