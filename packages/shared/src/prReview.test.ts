import { describe, expect, it } from "vitest";
import {
  isPrReviewAnchorInPatch,
  prReviewLines,
  substantivePrPatch,
  prComparisonsEqual,
} from "./prReview";

describe("PR review anchors", () => {
  const patch =
    "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -5,2 +8,3 @@\n context\n-old\n+new\n+extra\n";
  it("distinguishes old and new line numbers", () => {
    expect([...prReviewLines(patch).get("LEFT")!]).toEqual([5, 6]);
    expect([...prReviewLines(patch).get("RIGHT")!]).toEqual([8, 9, 10]);
    expect(isPrReviewAnchorInPatch({ path: "a", side: "RIGHT", line: 6 }, patch)).toBe(false);
  });
  it("rejects incomplete hunks and lines outside the patch", () => {
    expect(prReviewLines(patch.replace("+extra\n", "")).size).toBe(0);
    expect(prReviewLines(patch + "+unexpected\n").size).toBe(0);
    expect(isPrReviewAnchorInPatch({ path: "a", side: "LEFT", line: 0 }, patch)).toBe(false);
  });
  it("supports additions, deletions, no-newline markers and separated hunks", () => {
    expect([
      ...prReviewLines("@@ -0,0 +1 @@\n+new\n\\ No newline at end of file\n").get("RIGHT")!,
    ]).toEqual([1]);
    expect([...prReviewLines("@@ -1 +0,0 @@\n-old\n").get("LEFT")!]).toEqual([1]);
    expect([...prReviewLines("@@ -1 +1 @@\n one\n@@ -100 +101 @@\n two\n").get("RIGHT")!]).toEqual([
      1, 101,
    ]);
  });
});

it("hides whitespace-only hunks while preserving original line anchors", () => {
  const patch =
    "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old value\n+old  value\n@@ -10 +10 @@\n-before\n+after\n";
  const filtered = substantivePrPatch(patch)!;
  expect(filtered).not.toContain("@@ -1 +1 @@");
  expect([...prReviewLines(filtered).get("RIGHT")!]).toEqual([10]);
  expect(substantivePrPatch("@@ -1 +1 @@\n-one space\n+one  space\n")).toBeNull();
});

it("compares every revision dimension without depending on JSON property order", () => {
  const comparison = {
    mode: "current_pr" as const,
    baseRepository: "org/repo",
    baseRef: "main",
    baseOid: "base",
    headRepository: "fork/repo",
    headRef: "topic",
    headOid: "head",
    mergeBaseOid: "merge-base",
  };
  expect(prComparisonsEqual(comparison, { ...comparison, headOid: "head" })).toBe(true);
  for (const field of [
    "baseRepository",
    "baseRef",
    "baseOid",
    "headRepository",
    "headRef",
    "headOid",
    "mergeBaseOid",
  ] as const)
    expect(prComparisonsEqual(comparison, { ...comparison, [field]: "changed" })).toBe(false);
  expect(
    prComparisonsEqual(comparison, {
      ...comparison,
      mode: "changes_since_review",
      reviewedHeadOid: "previous",
    }),
  ).toBe(false);
  expect(prComparisonsEqual(undefined, undefined)).toBe(false);
});
