import { beforeEach, describe, expect, it, vi } from "vitest";

const getSharedHighlighter = vi.hoisted(() => vi.fn());

vi.mock("@pierre/diffs", () => ({ getSharedHighlighter }));

import { PREFERRED_HIGHLIGHTER } from "./diffRendering";
import { getMarkdownHighlighter } from "./markdownHighlighter";

describe("getMarkdownHighlighter", () => {
  beforeEach(() => {
    getSharedHighlighter.mockReset();
  });

  it("creates the shared highlighter with the Oniguruma WASM engine", async () => {
    const highlighter = { codeToHtml: vi.fn() };
    getSharedHighlighter.mockResolvedValue(highlighter);

    await expect(getMarkdownHighlighter("typescript")).resolves.toBe(highlighter);

    expect(PREFERRED_HIGHLIGHTER).toBe("shiki-wasm");
    expect(getSharedHighlighter).toHaveBeenCalledWith(
      expect.objectContaining({ langs: ["typescript"], preferredHighlighter: "shiki-wasm" }),
    );
  });

  it("falls back to plain text with the same engine when a grammar fails", async () => {
    const highlighter = { codeToHtml: vi.fn() };
    getSharedHighlighter
      .mockRejectedValueOnce(new Error("unknown language"))
      .mockResolvedValue(highlighter);

    await expect(getMarkdownHighlighter("not-a-language")).resolves.toBe(highlighter);

    expect(getSharedHighlighter).toHaveBeenLastCalledWith(
      expect.objectContaining({ langs: ["text"], preferredHighlighter: "shiki-wasm" }),
    );
  });
});
