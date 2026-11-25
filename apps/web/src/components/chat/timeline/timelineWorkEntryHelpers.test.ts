import { describe, expect, it } from "vitest";

import {
  changedFilesForPreview,
  formatMcpToolHeading,
  parseFileReadDetail,
  toolWorkEntryHeading,
  workToneClass,
} from "./timelineWorkEntryHelpers";

describe("timelineWorkEntryHelpers", () => {
  it("parses JSON file read details and classifies work tones", () => {
    expect(
      parseFileReadDetail('{"file_path":"src/app.ts","start_line":10,"end_line":25}'),
    ).toMatchObject({
      source: "structured",
      rawPath: "src/app.ts",
      line: 10,
      endLine: 25,
    });
    expect(parseFileReadDetail("not json")).toBeNull();
    expect(workToneClass("error")).toBeTruthy();
    expect(workToneClass("tool")).toBeTruthy();
  });

  it("formats MCP tool headings and deduplicates changed file previews", () => {
    expect(
      formatMcpToolHeading({
        id: "w1",
        createdAt: "2026-01-01T00:00:00.000Z",
        label: "MCP",
        tone: "tool",
        itemType: "mcp_tool_call",
        mcpServerName: "github",
        mcpToolName: "list_pull_requests",
      } as never),
    ).toBe("Github: List Pull Requests");

    expect(
      toolWorkEntryHeading({
        id: "w2",
        createdAt: "2026-01-01T00:00:00.000Z",
        label: "Ran command",
        tone: "tool",
      } as never),
    ).toBe("Ran command");

    expect(
      changedFilesForPreview(
        {
          cwd: "/repo",
          changedFiles: ["/repo/src/a.ts", "/repo/src/b.ts"],
        },
        new Map(),
        "/repo",
      )?.map((item) => item.displayPath),
    ).toEqual(["src/a.ts", "src/b.ts"]);
  });
});
