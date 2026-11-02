import { describe, expect, it } from "vitest";

import {
  materializeComposerPrompt,
  splitPromptIntoComposerSegments,
} from "../composer-editor-mentions";
import { collapseExpandedComposerCursor, expandCollapsedComposerCursor } from "../composer-logic";
import {
  F5_THREAD_REFERENCE_MIME,
  hasThreadReferenceDrag,
  readThreadReferenceDrag,
  writeThreadReferenceDrag,
} from "./threadReferenceDrag";

const transfer = () => {
  const values = new Map<string, string>();
  return {
    effectAllowed: "none" as DataTransfer["effectAllowed"],
    get types() {
      return [...values.keys()];
    },
    getData: (type: string) => values.get(type) ?? "",
    setData: (type: string, value: string) => {
      values.set(type, value);
    },
  };
};

describe("thread reference drags", () => {
  it("round-trips the dragged threads and offers plain links to other fields", () => {
    const data = transfer();
    const threads = [
      { threadId: "thread-1", title: "Fix [the] parser" },
      { threadId: "thread-2", title: "Second" },
    ];
    expect(writeThreadReferenceDrag(data, threads)).toBe(true);
    expect(data.effectAllowed).toBe("copy");
    expect(hasThreadReferenceDrag(data.types)).toBe(true);
    expect(readThreadReferenceDrag(data)).toEqual(threads);
    expect(data.getData("text/plain")).toMatch(
      /^\[Fix the parser\]\(f5(?:-dev)?:\/\/thread\/thread-1\) \[Second\]\(f5(?:-dev)?:\/\/thread\/thread-2\)$/,
    );
  });

  it("refuses to start a drag with no valid thread and caps it at ten", () => {
    expect(writeThreadReferenceDrag(transfer(), [{ threadId: "settings", title: "x" }])).toBe(
      false,
    );
    const data = transfer();
    const many = Array.from({ length: 12 }, (_, index) => ({
      threadId: `thread-${index}`,
      title: `T${index}`,
    }));
    expect(writeThreadReferenceDrag(data, many)).toBe(true);
    expect(readThreadReferenceDrag(data)).toHaveLength(10);
  });

  it.each([
    "null",
    "{}",
    "malformed",
    JSON.stringify({ version: 2, threads: [{ threadId: "a", title: "A" }] }),
    JSON.stringify({ version: 1, threads: [] }),
    JSON.stringify({
      version: 1,
      threads: Array.from({ length: 11 }, (_, index) => ({ threadId: `t${index}`, title: "T" })),
    }),
    JSON.stringify({ version: 1, threads: [{ threadId: "new", title: "A" }] }),
    JSON.stringify({ version: 1, threads: [{ threadId: "a/b", title: "A" }] }),
    JSON.stringify({ version: 1, threads: [{ threadId: "a", title: 7 }] }),
    JSON.stringify({ version: 1, threads: [{ threadId: "a", title: "x".repeat(501) }] }),
    "x".repeat(17 * 1024),
  ])("rejects an invalid payload", (value) => {
    const data = transfer();
    data.setData(F5_THREAD_REFERENCE_MIME, value);
    expect(readThreadReferenceDrag(data)).toBeNull();
  });
});

describe("thread reference composer segments", () => {
  const reference = "[Parser fix](f5://thread/thread-1)";
  const pr = "[PR #7](https://github.com/org/repo/pull/7)";

  it("splits thread references next to PR references and keeps the raw text", () => {
    const prompt = `Use ${reference} with ${pr}.`;
    const segments = splitPromptIntoComposerSegments(prompt);
    expect(segments).toEqual([
      { type: "text", text: "Use " },
      { type: "thread-reference", raw: reference, threadId: "thread-1", label: "Parser fix" },
      { type: "text", text: " with " },
      expect.objectContaining({ type: "pull-request", raw: pr }),
      { type: "text", text: "." },
    ]);
    expect(materializeComposerPrompt(prompt, [], []).prompt).toBe(prompt);
  });

  it("leaves prompt links with a query as text", () => {
    const prompt = "[Go](f5://thread/thread-1?prompt=hi)";
    expect(splitPromptIntoComposerSegments(prompt)).toEqual([{ type: "text", text: prompt }]);
  });

  it("treats a thread chip as one collapsed cursor unit", () => {
    const prompt = `a ${reference} b`;
    const afterChip = 2 + reference.length;
    expect(collapseExpandedComposerCursor(prompt, afterChip, [])).toBe(3);
    expect(expandCollapsedComposerCursor(prompt, 3, [])).toBe(afterChip);
    expect(expandCollapsedComposerCursor(prompt, 5, [])).toBe(prompt.length);
  });
});
