import { describe, expect, it } from "vitest";

import {
  changedFilesForPreview,
  formatMcpToolHeading,
  parseFileReadDetail,
  resolveInlineFilePreview,
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
    expect(workToneClass("error")).toBe("text-destructive-foreground");
    expect(workToneClass("tool")).toBe("text-muted-foreground");
    expect(workToneClass("thinking")).toBe("text-muted-foreground");
    expect(workToneClass("info")).toBe("text-muted-foreground");
  });

  it("formats MCP tool headings and workspace-relative changed file previews", () => {
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

  it("resolves inline file previews from read paths, changed files, and structured details", () => {
    expect(
      resolveInlineFilePreview(
        {
          label: "Read file",
          cwd: "/repo",
          readPaths: ["/repo/src/a.ts", "/repo/src/b.ts"],
          lineSummary: "lines 1-20",
        },
        new Map(),
        "/repo",
      ),
    ).toEqual({
      targetPath: "/repo/src/a.ts",
      label: "src/a.ts",
      text: "src/a.ts +1 more (lines 1-20)",
      trailingText: " +1 more (lines 1-20)",
    });

    expect(
      resolveInlineFilePreview(
        {
          label: "Dynamic tool",
          itemType: "dynamic_tool_call",
          cwd: "/repo",
          detail: '{"file_path":"src/index.ts","line":14,"column":3}',
        },
        new Map(),
        "/repo",
      ),
    ).toEqual({
      targetPath: "/repo/src/index.ts:14:3",
      label: "src/index.ts",
      text: "src/index.ts (line 14:3)",
      trailingText: " (line 14:3)",
    });

    expect(
      resolveInlineFilePreview(
        {
          label: "Read file",
          requestKind: "file-read",
          cwd: "/repo",
          detail: "src/plain.ts:42",
        },
        new Map(),
        "/repo",
      ),
    ).toEqual({
      targetPath: "/repo/src/plain.ts:42",
      label: "src/plain.ts",
      text: "src/plain.ts (line 42)",
      trailingText: " (line 42)",
    });
  });
});
