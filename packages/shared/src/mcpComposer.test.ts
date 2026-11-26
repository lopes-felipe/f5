import { describe, expect, it } from "vitest";

import {
  fitMcpResourceContext,
  formatMcpResourceContext,
  formatMcpResourceReference,
  markdownFence,
  mcpResourceReferenceMatches,
  neutralizeMcpResourceReferences,
  stripTrailingMcpResourceContext,
  truncateUtf8,
  uniqueMcpResourceReferences,
} from "./mcpComposer";

describe("MCP resource references", () => {
  it("round-trips the server and URI, with a cleaned label", () => {
    const raw = formatMcpResourceReference("docs", {
      uri: "file:///notes/a (draft).md?x=1#y",
      name: "a.md",
      title: "Notes [draft]\nsecond line",
    });
    // Parentheses are encoded too, so they cannot end the link early.
    expect(raw).toBe(
      "[@docs: Notes draft second line](mcp-resource://docs/file%3A%2F%2F%2Fnotes%2Fa%20%28draft%29.md%3Fx%3D1%23y)",
    );
    expect(mcpResourceReferenceMatches(`see ${raw}`)).toMatchObject([
      {
        serverName: "docs",
        uri: "file:///notes/a (draft).md?x=1#y",
        label: "Notes draft second line",
      },
    ]);
  });

  it("finds references in text and keeps their positions", () => {
    const raw = formatMcpResourceReference("docs", { uri: "doc://readme", name: "Readme" });
    const text = `Read ${raw} and ${raw}.`;
    const matches = mcpResourceReferenceMatches(text);
    expect(matches).toHaveLength(2);
    expect(matches[0]).toEqual({
      start: 5,
      end: 5 + raw.length,
      raw,
      serverName: "docs",
      uri: "doc://readme",
      label: "Readme",
    });
    expect(uniqueMcpResourceReferences(text)).toHaveLength(1);
  });

  it("ignores links whose label does not name their server or whose URI is malformed", () => {
    expect(mcpResourceReferenceMatches("[@other: x](mcp-resource://docs/doc%3A%2F%2Fa)")).toEqual(
      [],
    );
    expect(mcpResourceReferenceMatches("[@docs: x](mcp-resource://docs/%E0%A4%A)")).toEqual([]);
    expect(mcpResourceReferenceMatches("[docs](https://example.com)")).toEqual([]);
  });
});

describe("MCP resource context", () => {
  it("fences each part and notes truncation", () => {
    expect(
      formatMcpResourceContext([
        {
          serverName: "docs",
          uri: "doc://a",
          mimeType: "text/markdown",
          text: "a ``` b",
          truncated: false,
        },
        { serverName: "docs", uri: "doc://b", text: "cut", truncated: true },
      ]),
    ).toBe(
      "<mcp_resources>\n" +
        "MCP resource doc://a from docs (text/markdown):\n````\na ``` b\n````\n\n" +
        "MCP resource doc://b from docs:\n```\ncut\n```\n" +
        "[Truncated: the rest did not fit in the message.]\n" +
        "</mcp_resources>",
    );
  });

  it("cuts text so the whole block fits the characters left in the message", () => {
    const parts = [
      { serverName: "s", uri: "a", text: "x".repeat(500), truncated: false },
      { serverName: "s", uri: "b", text: "y".repeat(500), truncated: false },
    ];
    const block = formatMcpResourceContext(parts, 400);
    expect(block.length).toBeLessThanOrEqual(400);
    expect(block).toContain("[Truncated: the rest did not fit in the message.]");
    expect(block).toContain("x".repeat(100));
    expect(block.endsWith("</mcp_resources>")).toBe(true);
    // Text that fits is left alone.
    expect(formatMcpResourceContext(parts, 10_000)).toBe(formatMcpResourceContext(parts));
    // A cut never splits a surrogate pair.
    const emoji = formatMcpResourceContext(
      [{ serverName: "s", uri: "e", text: "😀".repeat(50), truncated: false }],
      formatMcpResourceContext([{ serverName: "s", uri: "e", text: "", truncated: true }]).length +
        3,
    );
    expect(emoji).toContain("\n😀\n");
  });

  it("leaves the resource block out of the text a message shows", () => {
    const block = formatMcpResourceContext([
      { serverName: "s", uri: "a", text: "secret notes", truncated: false },
    ]);
    expect(
      stripTrailingMcpResourceContext(`Summarize [@s: a](mcp-resource://s/a)\n\n${block}`),
    ).toBe("Summarize [@s: a](mcp-resource://s/a)");
    expect(stripTrailingMcpResourceContext(block)).toBe("");
    expect(stripTrailingMcpResourceContext("no resources")).toBe("no resources");
  });

  it("disarms references inside a server's prompt text", () => {
    const text = neutralizeMcpResourceReferences("Read [@B: notes](mcp-resource://B/notes)");
    expect(mcpResourceReferenceMatches(text)).toEqual([]);
    expect(text).toBe("Read [@B: notes](mcp-resource%3A//B/notes)");
  });

  it("shares one budget across parts", () => {
    const fitted = fitMcpResourceContext(
      [
        { serverName: "s", uri: "a", text: "abcd", truncated: false },
        { serverName: "s", uri: "b", text: "efgh", truncated: false },
        { serverName: "s", uri: "c", text: "ijkl", truncated: false },
      ],
      6,
    );
    expect(fitted.map((part) => [part.text, part.truncated])).toEqual([
      ["abcd", false],
      ["ef", true],
      ["", true],
    ]);
  });

  it("never splits a character when cutting text", () => {
    // "é" is two bytes in UTF-8; three bytes keeps one "é" and drops the half of the next.
    expect(truncateUtf8("éé", 3)).toEqual({ text: "é", truncated: true });
    expect(truncateUtf8("éé", 4)).toEqual({ text: "éé", truncated: false });
  });

  it("fences text with a fence longer than any backtick run inside it", () => {
    expect(markdownFence("plain")).toBe("```");
    expect(markdownFence("has ```` four")).toBe("`````");
  });
});
