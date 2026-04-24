import { describe, expect, it } from "vitest";

import { EMPTY_STREAMING_MARKDOWN_STATE, advanceStreamingMarkdown } from "./streamingMarkdown";

describe("advanceStreamingMarkdown", () => {
  it("keeps an append-only paragraph active until a boundary seals it", () => {
    const initial = advanceStreamingMarkdown(null, "Hello");

    expect(initial.sealedBlocks).toEqual([]);
    expect(initial.activeBlock).toBe("Hello");
    expect(initial.activeBlockKind).toBe("paragraph");
    expect(initial.needsFullRebuild).toBe(false);

    const next = advanceStreamingMarkdown(initial, "Hello\n\nWorld");

    expect(next.sealedBlocks).toEqual(["Hello\n"]);
    expect(next.activeBlock).toBe("World");
    expect(next.activeBlockKind).toBe("paragraph");
    expect(next.needsFullRebuild).toBe(false);
  });

  it("seals a heading before the following paragraph", () => {
    const next = advanceStreamingMarkdown(null, "# Title\n\nParagraph");

    expect(next.sealedBlocks).toEqual(["# Title\n"]);
    expect(next.activeBlock).toBe("Paragraph");
    expect(next.activeBlockKind).toBe("paragraph");
  });

  it("keeps list growth in the active cluster until the list ends", () => {
    const initial = advanceStreamingMarkdown(null, "- first\n- second");

    expect(initial.sealedBlocks).toEqual([]);
    expect(initial.activeBlock).toBe("- first\n- second");
    expect(initial.activeBlockKind).toBe("list");

    const next = advanceStreamingMarkdown(initial, "- first\n- second\n\nAfter list");

    expect(next.sealedBlocks).toEqual(["- first\n- second\n"]);
    expect(next.activeBlock).toBe("After list");
    expect(next.activeBlockKind).toBe("paragraph");
  });

  it("keeps blockquote growth in the active cluster until it ends", () => {
    const initial = advanceStreamingMarkdown(null, "> first\n> second");

    expect(initial.sealedBlocks).toEqual([]);
    expect(initial.activeBlock).toBe("> first\n> second");
    expect(initial.activeBlockKind).toBe("blockquote");

    const next = advanceStreamingMarkdown(initial, "> first\n> second\n\nAfter quote");

    expect(next.sealedBlocks).toEqual(["> first\n> second\n"]);
    expect(next.activeBlock).toBe("After quote");
    expect(next.activeBlockKind).toBe("paragraph");
  });

  it("keeps a table active until a non-table boundary appears", () => {
    const initial = advanceStreamingMarkdown(null, "| A | B |\n| --- | --- |\n| 1 | 2 |");

    expect(initial.sealedBlocks).toEqual([]);
    expect(initial.activeBlock).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |");
    expect(initial.activeBlockKind).toBe("table");

    const next = advanceStreamingMarkdown(
      initial,
      "| A | B |\n| --- | --- |\n| 1 | 2 |\n\nAfter table",
    );

    expect(next.sealedBlocks).toEqual(["| A | B |\n| --- | --- |\n| 1 | 2 |\n"]);
    expect(next.activeBlock).toBe("After table");
    expect(next.activeBlockKind).toBe("paragraph");
  });

  it("distinguishes open and closed fenced code blocks", () => {
    const openFence = advanceStreamingMarkdown(null, "```ts\nconst x = 1;");

    expect(openFence.sealedBlocks).toEqual([]);
    expect(openFence.activeBlock).toBe("```ts\nconst x = 1;");
    expect(openFence.activeBlockKind).toBe("fenced-code");

    const closedFence = advanceStreamingMarkdown(openFence, "```ts\nconst x = 1;\n```\n\nTail");

    expect(closedFence.sealedBlocks).toEqual(["```ts\nconst x = 1;\n```\n"]);
    expect(closedFence.activeBlock).toBe("Tail");
    expect(closedFence.activeBlockKind).toBe("paragraph");
  });

  it("forces a rebuild when the next snapshot replaces the prefix", () => {
    const initial = advanceStreamingMarkdown(null, "Original");
    const replaced = advanceStreamingMarkdown(initial, "Replacement");

    expect(replaced.sealedBlocks).toEqual([]);
    expect(replaced.activeBlock).toBe("Replacement");
    expect(replaced.activeBlockKind).toBe("paragraph");
    expect(replaced.needsFullRebuild).toBe(true);
  });

  it("returns the shared empty state for empty initial input", () => {
    expect(advanceStreamingMarkdown(null, "")).toBe(EMPTY_STREAMING_MARKDOWN_STATE);
  });
});
