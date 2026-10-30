import { describe, expect, it } from "vitest";

import {
  formatThreadReference,
  isThreadReferenceId,
  referencedThreadIds,
  sanitizeThreadReferenceLabel,
  THREAD_REFERENCE_LABEL_MAX_LENGTH,
  THREAD_REFERENCE_MAX_PER_MESSAGE,
  threadIdOfThreadReferenceUrl,
  threadReferenceMatches,
  threadReferencesToLabels,
} from "./threadReferences";

describe("threadReferenceMatches", () => {
  it("matches production and development schemes in order", () => {
    const text = "See [Alpha](f5://thread/a-1) and [Beta](f5-dev://thread/b_2).";
    expect(threadReferenceMatches(text)).toEqual([
      { start: 4, end: 28, raw: "[Alpha](f5://thread/a-1)", label: "Alpha", threadId: "a-1" },
      {
        start: 33,
        end: 60,
        raw: "[Beta](f5-dev://thread/b_2)",
        label: "Beta",
        threadId: "b_2",
      },
    ]);
  });

  it("ignores links that are not bare thread references", () => {
    for (const text of [
      "[A](https://thread/abc)",
      "[A](f5://thread/abc?prompt=hi)",
      "[A](f5://thread/settings)",
      "[A](f5://thread/a.b)",
      `[A](f5://thread/${"x".repeat(129)})`,
      "f5://thread/abc",
      "[A](f5://new)",
      "[](f5://thread/abc)",
      "[A\nB](f5://thread/abc)",
    ]) {
      expect(threadReferenceMatches(text)).toEqual([]);
    }
  });

  it("keeps backticks and bold markers inside the label", () => {
    expect(threadReferenceMatches("[`fix` **now**](f5://thread/t1)")[0]?.label).toBe(
      "`fix` **now**",
    );
  });
});

describe("sanitizeThreadReferenceLabel", () => {
  it("replaces characters that would break the link or the chip", () => {
    expect(sanitizeThreadReferenceLabel("  a [b] \\c\nd\u0007e\ufffcf  ")).toBe("a b c d e f");
  });

  it("falls back for an empty label", () => {
    expect(sanitizeThreadReferenceLabel(" [] \n")).toBe("Thread");
  });

  it("caps the label without splitting a surrogate pair", () => {
    const label = sanitizeThreadReferenceLabel(`${"a".repeat(119)}\u{1F600}tail`);
    expect(label).toBe("a".repeat(119));
    expect(sanitizeThreadReferenceLabel("b".repeat(500))).toHaveLength(
      THREAD_REFERENCE_LABEL_MAX_LENGTH,
    );
  });
});

describe("formatThreadReference", () => {
  it("formats a reference that matches back to the same thread", () => {
    const raw = formatThreadReference({ threadId: "t-1", title: "Fix [bug]" });
    expect(raw).toBe("[Fix bug](f5://thread/t-1)");
    expect(threadReferenceMatches(raw)[0]?.threadId).toBe("t-1");
    expect(formatThreadReference({ threadId: "t-1", title: "X", scheme: "f5-dev" })).toBe(
      "[X](f5-dev://thread/t-1)",
    );
  });
});

describe("referencedThreadIds", () => {
  it("dedupes, excludes and caps", () => {
    const refs = Array.from(
      { length: 12 },
      (_, index) => `[T${index}](f5://thread/t${index})`,
    ).join(" ");
    const ids = referencedThreadIds([`[Self](f5://thread/self) ${refs} [T0](f5://thread/t0)`], {
      exclude: "self",
    });
    expect(ids).toHaveLength(THREAD_REFERENCE_MAX_PER_MESSAGE);
    expect(ids[0]).toBe("t0");
    expect(ids).not.toContain("self");
  });
});

describe("threadReferencesToLabels", () => {
  it("replaces each reference with its label", () => {
    expect(threadReferencesToLabels("Use [Alpha](f5://thread/a) and [Beta](f5://thread/b)")).toBe(
      "Use Alpha and Beta",
    );
    expect(threadReferencesToLabels("no refs")).toBe("no refs");
  });
});

describe("thread reference ids and urls", () => {
  it("accepts only bare thread links", () => {
    expect(threadIdOfThreadReferenceUrl("f5://thread/abc")).toBe("abc");
    expect(threadIdOfThreadReferenceUrl("f5-dev://thread/abc")).toBe("abc");
    expect(threadIdOfThreadReferenceUrl("f5://thread/abc?prompt=x")).toBe(null);
    expect(threadIdOfThreadReferenceUrl("f5://thread/new")).toBe(null);
    expect(isThreadReferenceId("abc_1-2")).toBe(true);
    expect(isThreadReferenceId("a b")).toBe(false);
    expect(isThreadReferenceId("settings")).toBe(false);
  });
});
