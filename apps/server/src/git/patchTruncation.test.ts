import { describe, expect, it } from "vitest";

import { truncatePatchAtFileBoundary } from "./patchTruncation.ts";

describe("truncatePatchAtFileBoundary", () => {
  it.each([0, 1, 5, 43, 44, 45])(
    "bounds the omission marker within a %i-byte allowance",
    (limit) => {
      const result = truncatePatchAtFileBoundary(
        `diff --git a/a b/a\n${"+😀\n".repeat(100)}`,
        false,
        limit,
      );
      expect(Buffer.byteLength(result.patch)).toBeLessThanOrEqual(limit);
      expect(result.patch).not.toContain("\uFFFD");
      expect(result.truncated).toBe(true);
    },
  );
  it("retains evidence when the first file alone exceeds the limit", () => {
    const patch = `diff --git a/large.txt b/large.txt\n${"+payload\n".repeat(2_000)}`;
    const result = truncatePatchAtFileBoundary(patch, false, 1_024);
    expect(result.truncated).toBe(true);
    expect(result.patch).toContain("diff --git a/large.txt b/large.txt");
    expect(result.patch).toContain("oversized file patch middle omitted");
    expect(Buffer.byteLength(result.patch)).toBeLessThanOrEqual(1_024);
    expect(result.reason).toMatch(/original bytes.*retained bytes.*omitted bytes/);
  });

  it("bounds a headerless patch instead of returning an empty artifact", () => {
    const result = truncatePatchAtFileBoundary("é".repeat(2_000), false, 512);
    expect(result.patch.length).toBeGreaterThan(0);
    expect(result.patch).not.toContain("�");
    expect(Buffer.byteLength(result.patch)).toBeLessThanOrEqual(512);
  });

  it("reports source truncation even when the supplied text fits", () => {
    const result = truncatePatchAtFileBoundary("diff --git a/a b/a\n+partial\n", true, 1_024);
    expect(result.truncated).toBe(true);
    expect(result.patch).toContain("diff --git");
  });
});
