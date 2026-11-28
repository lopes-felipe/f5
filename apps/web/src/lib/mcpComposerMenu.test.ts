import { describe, expect, it } from "vitest";

import {
  MCP_MENU_ITEM_LIMIT,
  isMcpImageResource,
  mcpPromptMenuItems,
  mcpResourceImageFiles,
  mcpResourceMenuItems,
  mcpResourceTextParts,
} from "./mcpComposerMenu";

describe("MCP composer menu", () => {
  it("lists prompts as /server:prompt, matching the command or title", () => {
    const servers = [
      {
        serverName: "docs",
        prompts: [
          { name: "summarize", title: "Summarize a topic", arguments: [{ name: "topic" }] },
          { name: "outline", arguments: [] },
        ],
      },
    ];
    expect(mcpPromptMenuItems(servers, "").map((item) => item.label)).toEqual([
      "/docs:summarize",
      "/docs:outline",
    ]);
    expect(mcpPromptMenuItems(servers, "docs:out").map((item) => item.label)).toEqual([
      "/docs:outline",
    ]);
    const [summarize] = mcpPromptMenuItems(servers, "topic");
    expect(summarize?.description).toBe("Summarize a topic (asks for input)");
    expect(mcpPromptMenuItems(undefined, "")).toEqual([]);
  });

  it("filters resources by name, title, URI or server and caps the list", () => {
    const servers = [
      {
        serverName: "docs",
        resources: Array.from({ length: MCP_MENU_ITEM_LIMIT + 10 }, (_, index) => ({
          uri: `doc://${index}`,
          name: `page-${index}`,
        })),
        truncated: false,
      },
      {
        serverName: "media",
        resources: [{ uri: "img://logo", name: "logo", title: "Logo", mimeType: "image/png" }],
        truncated: false,
      },
    ];
    expect(mcpResourceMenuItems(servers, "")).toHaveLength(MCP_MENU_ITEM_LIMIT);
    const [logo] = mcpResourceMenuItems(servers, "media");
    expect(logo).toMatchObject({ label: "Logo", description: "media · img://logo" });
    expect(isMcpImageResource(logo!)).toBe(true);
    // Types F5 cannot attach as images are added as text instead.
    const asType = (mimeType: string) => ({
      ...logo!,
      resource: { ...logo!.resource, mimeType },
    });
    expect(isMcpImageResource(asType("image/svg+xml"))).toBe(false);
    expect(isMcpImageResource(asType("IMAGE/JPEG; charset=binary"))).toBe(true);
    expect(mcpResourceMenuItems(servers, "doc://7")[0]?.label).toBe("page-7");
  });

  it("turns image contents into files and keeps text parts for sending", () => {
    const read = {
      contents: [
        { kind: "text" as const, uri: "doc://a", text: "hello", truncated: false },
        { kind: "image" as const, uri: "img://dir/logo", mimeType: "image/png", data: btoa("png") },
      ],
      omitted: 1,
    };
    const [file] = mcpResourceImageFiles(read, "Logo");
    expect(file?.name).toBe("logo.png");
    expect(file?.type).toBe("image/png");
    expect(file?.size).toBe(3);
    expect(mcpResourceTextParts("docs", read)).toEqual({
      parts: [
        {
          serverName: "docs",
          uri: "doc://a",
          mimeType: undefined,
          text: "hello",
          truncated: false,
        },
      ],
      omitted: 2,
    });
  });
});
