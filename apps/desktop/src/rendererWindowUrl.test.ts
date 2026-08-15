import { describe, expect, it } from "vitest";

import { normalizeThreadIdForDesktopWindow, rendererUrlForThread } from "./rendererWindowUrl";

describe("normalizeThreadIdForDesktopWindow", () => {
  it("accepts a bounded route segment and rejects path injection", () => {
    expect(normalizeThreadIdForDesktopWindow(" thread-123 ")).toBe("thread-123");
    expect(normalizeThreadIdForDesktopWindow("../settings")).toBeNull();
    expect(normalizeThreadIdForDesktopWindow("thread/child")).toBeNull();
    expect(normalizeThreadIdForDesktopWindow("thread\0child")).toBeNull();
  });
});

describe("rendererUrlForThread", () => {
  it("loads the thread route through Electron hash history", () => {
    expect(rendererUrlForThread("t3://app/index.html", "thread 123")).toBe(
      "t3://app/index.html#/thread%20123",
    );
    expect(rendererUrlForThread("http://localhost:5173/#/old", "thread-2")).toBe(
      "http://localhost:5173/#/thread-2",
    );
  });
});
