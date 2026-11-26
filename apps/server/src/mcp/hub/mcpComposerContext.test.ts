import type { ListResourcesResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import type { McpHubComposerServer } from "./McpHub.ts";
import {
  flattenPrompt,
  listComposerPrompts,
  listComposerResources,
  markdownFence,
  shapeResourceContents,
  truncateUtf8,
} from "./mcpComposerContext.ts";

function fakeServer(overrides: Partial<McpHubComposerServer>): McpHubComposerServer {
  return {
    listPrompts: async () => ({ prompts: [] }),
    getPrompt: async () => ({ messages: [] }),
    complete: async () => ({ completion: { values: [] } }),
    listResources: async () => ({ resources: [] }),
    readResource: async () => ({ contents: [] }),
    ...overrides,
  };
}

describe("composer prompts", () => {
  it("keeps text and text resources, links resource links and counts the rest", () => {
    expect(
      flattenPrompt({
        messages: [
          { role: "user", content: { type: "text", text: "Review this:" } },
          {
            role: "user",
            content: {
              type: "resource",
              resource: { uri: "file:///a.ts", text: "const a = ```x```;" },
            },
          },
          { role: "user", content: { type: "image", data: "AA==", mimeType: "image/png" } },
          {
            role: "user",
            content: { type: "resource", resource: { uri: "file:///b.bin", blob: "AA==" } },
          },
          {
            role: "user",
            content: { type: "resource_link", uri: "https://example.com/doc", name: "Doc" },
          },
        ],
      }),
    ).toEqual({
      text: "Review this:\n\nfile:///a.ts\n````\nconst a = ```x```;\n````\n\n[Doc](https://example.com/doc)",
      omitted: 2,
    });
  });

  it("lists every server sorted, and reports one server's failure without hiding the others", async () => {
    const servers = new Map<string, McpHubComposerServer>([
      [
        "zeta",
        fakeServer({
          listPrompts: async () => ({
            prompts: [
              { name: "  " },
              { name: "plan", title: "Plan", arguments: [{ name: "goal" }] },
            ],
          }),
        }),
      ],
      [
        "alpha",
        fakeServer({
          listPrompts: async () => {
            throw new Error("server crashed");
          },
        }),
      ],
    ]);
    expect(await listComposerPrompts(servers)).toEqual([
      { serverName: "alpha", prompts: [], error: "server crashed" },
      {
        serverName: "zeta",
        prompts: [{ name: "plan", title: "Plan", arguments: [{ name: "goal" }] }],
      },
    ]);
  });
});

describe("composer resources", () => {
  it("lists up to 200 per server across pages and marks the rest as truncated", async () => {
    const page = (start: number, nextCursor?: string): ListResourcesResult => ({
      resources: Array.from({ length: 150 }, (_, index) => ({
        uri: `doc://${start + index}`,
        name: `Doc ${start + index}`,
      })),
      ...(nextCursor ? { nextCursor } : {}),
    });
    const cursors: Array<string | undefined> = [];
    const servers = new Map([
      [
        "docs",
        fakeServer({
          listResources: async (params) => {
            cursors.push(params?.cursor);
            return params?.cursor ? page(150, "more") : page(0, "second");
          },
        }),
      ],
    ]);
    const [listed] = await listComposerResources(servers);
    expect(cursors).toEqual([undefined, "second"]);
    expect(listed?.resources).toHaveLength(200);
    expect(listed?.resources.at(-1)?.uri).toBe("doc://199");
    expect(listed?.truncated).toBe(true);
  });

  it("is not truncated when the last page fits", async () => {
    const servers = new Map([
      [
        "docs",
        fakeServer({
          listResources: async () => ({ resources: [{ uri: "doc://1", name: "One" }] }),
        }),
      ],
    ]);
    expect((await listComposerResources(servers))[0]?.truncated).toBe(false);
  });

  it("cuts text to the shared budget, keeps images and leaves out other binary parts", () => {
    const shaped = shapeResourceContents(
      {
        contents: [
          { uri: "doc://a", mimeType: "text/plain", text: "abcdef" },
          { uri: "doc://b", text: "ghijkl" },
          { uri: "img://c", mimeType: "IMAGE/PNG", blob: "iVBORw0KGgo=" },
          { uri: "bin://d", mimeType: "application/pdf", blob: "JVBERi0=" },
        ],
      },
      8,
    );
    expect(shaped).toEqual({
      contents: [
        { kind: "text", uri: "doc://a", mimeType: "text/plain", text: "abcdef", truncated: false },
        { kind: "text", uri: "doc://b", text: "gh", truncated: true },
        { kind: "image", uri: "img://c", mimeType: "image/png", data: "iVBORw0KGgo=" },
      ],
      omitted: 1,
    });
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
