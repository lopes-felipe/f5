import { describe, expect, it } from "vitest";
import { isProtectedIgnoredPath, parseCleanupSafetyStatus } from "./cleanupSafety.ts";

describe("cleanup safety porcelain", () => {
  it("keeps ignored and untracked paths with whitespace and newlines intact", () => {
    expect(
      parseCleanupSafetyStatus("? odd name\n.txt\0! dist/.env.local\0! dist/out.js\0"),
    ).toEqual({
      hasTrackedChanges: false,
      hasUntrackedChanges: true,
      ignoredEntries: ["dist/.env.local", "dist/out.js"],
      ignoredTruncated: false,
    });
  });
  it("consumes the second rename path as data rather than another status record", () => {
    expect(
      parseCleanupSafetyStatus("2 R. N... 100644 100644 100644 a b R100 new\0! old\0"),
    ).toEqual({
      hasTrackedChanges: true,
      hasUntrackedChanges: false,
      ignoredEntries: [],
      ignoredTruncated: false,
    });
  });
  it("fails closed on truncated and unknown status records", () => {
    expect(() => parseCleanupSafetyStatus("? path")).toThrow("Incomplete");
    expect(() => parseCleanupSafetyStatus("2 rename\0")).toThrow("Incomplete");
    expect(() => parseCleanupSafetyStatus("unknown\0")).toThrow("Unrecognized");
  });
  it("protects exact environment-file segments at any depth", () => {
    expect(
      [".env", ".env.local", "dist/.env.local", "x/.env/file"].every(isProtectedIgnoredPath),
    ).toBe(true);
    expect(
      ["dist/out.js", "dotenv", ".environment", "node_modules/file"].some(isProtectedIgnoredPath),
    ).toBe(false);
  });
});
