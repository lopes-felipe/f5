import { describe, expect, it } from "vitest";
import {
  describeDynamicToolEntry,
  humanizeToolName,
  mcpServerMonogram,
  parseJsonObject,
  summarizeToolInputPairs,
  timelineIsAtEnd,
} from "./MessagesTimeline.logic";

describe("describeDynamicToolEntry", () => {
  const tool = (detail: string, overrides: { itemType?: string; toolTitle?: string } = {}) =>
    describeDynamicToolEntry({
      itemType: (overrides.itemType ?? "dynamic_tool_call") as "dynamic_tool_call",
      label: "Tool call",
      toolTitle: overrides.toolTitle ?? "Tool call",
      detail,
    });

  it("names the tool and previews its telling input field", () => {
    expect(tool('ToolSearch: {"query":"select:ExitPlanMode","max_results":1}')).toEqual({
      heading: "Tool search",
      preview: "select:ExitPlanMode",
      icon: "search",
    });
    expect(tool('WebFetch: {"url":"https://docs.example.com/api","prompt":"Summarize"}')).toEqual({
      heading: "Web fetch",
      preview: "docs.example.com/api",
      icon: "web",
    });
    expect(tool('TaskCreate: {"subject":"Add Q&A card","description":"Long text"}')).toEqual({
      heading: "Task create",
      preview: "Add Q&A card",
      icon: "tasks",
    });
  });

  it("keeps plain-text details and falls back to key: value pairs", () => {
    expect(tool("TodoWrite: 3 tasks")).toEqual({
      heading: "Todo write",
      preview: "3 tasks",
      icon: "tasks",
    });
    expect(tool('Frobnicate: {"level":3,"dry":true,"mode":"fast","extra":"x"}')?.preview).toBe(
      "level: 3 · dry: true · mode: fast",
    );
  });

  it("reads the telling field out of cut-off JSON", () => {
    expect(tool('Skill: {"skill":"run","args":"--very long \\"quoted\\"...')?.preview).toBe("run");
    expect(tool('WebSearchTool: {"query":"effect schema unions and')?.preview).toBe(
      "effect schema unions and",
    );
  });

  it("previews what an AskUserQuestion call asked", () => {
    expect(
      tool('AskUserQuestion: {"questions":[{"question":"Layout?"},{"question":"History?"}]}')
        ?.preview,
    ).toBe("Layout? · History?");
    expect(tool('AskUserQuestion: {"questions":[{"question":"How should tile...')?.preview).toBe(
      "How should tile...",
    );
  });

  it("requires a space after the tool name's colon", () => {
    expect(tool("https://example.com/path")).toBeNull();
    expect(tool("C:\\Users\\me\\file.txt")).toBeNull();
  });

  it("leaves named and non-generic rows alone", () => {
    expect(tool('Read: {"file_path":"a.ts"}', { toolTitle: "Read file" })).toBeNull();
    expect(tool("ToolSearch: x", { itemType: "mcp_tool_call" })).toBeNull();
    expect(tool("no separator here")).toBeNull();
  });
});

describe("tool naming helpers", () => {
  it("humanizes tool names", () => {
    expect(humanizeToolName("ToolSearch")).toBe("Tool search");
    expect(humanizeToolName("mcp__f5_thread__html_render")).toBe("Html render");
    expect(humanizeToolName("readMCPResource")).toBe("Read mcp resource");
  });

  it("refuses to parse JSON whose numbers would be rounded", () => {
    expect(parseJsonObject('{"id":9007199254740993}')).toBeNull();
    expect(parseJsonObject('{"id":-12345678901234567890}')).toBeNull();
    expect(parseJsonObject('{"id":9.007199254740993e15}')).toBeNull();
    expect(parseJsonObject('{"ratio":0.12345678901234567890123}')).toBeNull();
    expect(parseJsonObject('{"big":1e400}')).toBeNull();
    // Exact numbers in other spellings, and digits inside strings, still parse.
    expect(
      parseJsonObject(
        '{"id":"9007199254740993","n":42,"half":5e-1,"one":1.0,"neg":-0.25,"e":"x1e999"}',
      ),
    ).toEqual({ id: "9007199254740993", n: 42, half: 0.5, one: 1, neg: -0.25, e: "x1e999" });
    expect(parseJsonObject('{"q":"say \\"12345678901234567890\\""}')).toEqual({
      q: 'say "12345678901234567890"',
    });
    expect(parseJsonObject('["not","an","object"]')).toBeNull();
  });

  it("builds MCP server monograms from up to two name segments", () => {
    expect(mcpServerMonogram("f5_thread")).toBe("FT");
    expect(mcpServerMonogram("github")).toBe("G");
    expect(mcpServerMonogram("claudeAiDocs")).toBe("CA");
  });

  it("summarizes MCP input as quoted key: value pairs", () => {
    expect(
      summarizeToolInputPairs(
        { title: "Card options", height: 780, nested: { a: 1 }, flag: false, more: "x" },
        { quoteStrings: true },
      ),
    ).toBe('title: "Card options" · height: 780 · flag: false');
    expect(summarizeToolInputPairs({ text: "a".repeat(80) })).toBe(`text: ${"a".repeat(59)}…`);
    expect(summarizeToolInputPairs({ nested: {} })).toBeNull();
  });
});

it("rearms following only in the last forty pixels, independently of viewport height", () => {
  expect(timelineIsAtEnd({ contentLength: 5_000, scrollLength: 2_000, scroll: 2_970 })).toBe(true);
  expect(timelineIsAtEnd({ contentLength: 5_000, scrollLength: 2_000, scroll: 2_900 })).toBe(false);
  expect(timelineIsAtEnd({ contentLength: 500, scrollLength: 1_000, scroll: 0 })).toBe(true);
});
import {
  buildTimelineEntryRowIndexMap,
  computeMessageDurationStart,
  deriveTimelineTurnRailItems,
  deriveTimelineAssistantRailItems,
  deriveCodexCollaborationResponseRows,
  findLastUserMessageRowIndex,
  findNearestMinimapMarkerIndex,
  formatWorkingLabel,
  summarizeWorkGroup,
  type WorkEntryClassificationSource,
  normalizeCompactToolLabel,
  resolveActiveTurnRailIndex,
  resolveCodexCollaborationHeading,
  resolveCodexCollaborationStatusLabel,
  resolveTimelineTurnRailHasPersistentGutter,
  resolveTimelineTurnRailHeightStyle,
  resolveTimelineTurnRailHitStripWidth,
  resolveTimelineTurnRailIndexFromPointer,
  resolveTimelineTurnRailInteractiveWidth,
  resolveTimelineTurnRailTopPercent,
  sampleTimelineMinimapRowIndices,
  TURN_RAIL_PREVIEW_DISPLAY_CHARS,
} from "./MessagesTimeline.logic";
import { IMAGE_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerSendText";
import { appendAttachedFilesToPrompt } from "../../lib/attachedFiles";
import { appendTerminalContextsToPrompt } from "../../lib/terminalContext";

describe("formatWorkingLabel", () => {
  const startedAt = "2026-03-04T12:00:00.000Z";

  it("shows an ellipsis before the turn has a start time", () => {
    expect(formatWorkingLabel(null, startedAt)).toBe("Working…");
  });

  it("shows the elapsed time", () => {
    expect(formatWorkingLabel(startedAt, startedAt)).toBe("Working · 0s");
    expect(formatWorkingLabel(startedAt, "2026-03-04T12:01:12.000Z")).toBe("Working · 1m 12s");
  });
});

describe("computeMessageDurationStart", () => {
  it("returns message createdAt when there is no preceding user message", () => {
    const result = computeMessageDurationStart([
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:05Z",
        completedAt: "2026-01-01T00:00:10Z",
      },
    ]);
    expect(result).toEqual(new Map([["a1", "2026-01-01T00:00:05Z"]]));
  });

  it("uses the user message createdAt for the first assistant response", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("uses the previous assistant completedAt for subsequent assistant responses", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        completedAt: "2026-01-01T00:00:55Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["a2", "2026-01-01T00:00:30Z"],
      ]),
    );
  });

  it("does not advance the boundary for a streaming message without completedAt", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      { id: "a1", role: "assistant", createdAt: "2026-01-01T00:00:30Z" },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        completedAt: "2026-01-01T00:00:55Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["a2", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("resets the boundary on a new user message", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
      { id: "u2", role: "user", createdAt: "2026-01-01T00:01:00Z" },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:01:20Z",
        completedAt: "2026-01-01T00:01:20Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["u2", "2026-01-01T00:01:00Z"],
        ["a2", "2026-01-01T00:01:00Z"],
      ]),
    );
  });

  it("handles system messages without affecting the boundary", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      { id: "s1", role: "system", createdAt: "2026-01-01T00:00:01Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["s1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("returns empty map for empty input", () => {
    expect(computeMessageDurationStart([])).toEqual(new Map());
  });
});

describe("normalizeCompactToolLabel", () => {
  it("removes trailing completion wording from command labels", () => {
    expect(normalizeCompactToolLabel("Ran command complete")).toBe("Ran command");
  });

  it("removes trailing completion wording from other labels", () => {
    expect(normalizeCompactToolLabel("Read file completed")).toBe("Read file");
  });
});

describe("timeline row navigation mapping", () => {
  it("maps grouped entry ids onto their rendered row", () => {
    expect(
      buildTimelineEntryRowIndexMap([
        { id: "message-1" },
        { id: "work-group", groupedEntryIds: ["tool-1", "tool-2"] },
        { id: "message-2" },
      ]),
    ).toEqual(
      new Map([
        ["message-1", 0],
        ["work-group", 1],
        ["tool-1", 1],
        ["tool-2", 1],
        ["message-2", 2],
      ]),
    );
  });

  it("caps large timelines while preserving the ends and active row", () => {
    const markers = sampleTimelineMinimapRowIndices({
      rowCount: 1_000,
      boundaryIndices: Array.from({ length: 300 }, (_, index) => index * 3),
      activeRowIndex: 777,
    });
    expect(markers.length).toBeLessThanOrEqual(200);
    expect(markers[0]).toBe(0);
    expect(markers.at(-1)).toBe(999);
    expect(markers).toContain(777);
  });

  it("binary-searches the nearest marker", () => {
    expect(findNearestMinimapMarkerIndex([0, 20, 40, 90], 34)).toBe(2);
    expect(findNearestMinimapMarkerIndex([0, 20, 40, 90], 25)).toBe(1);
  });

  it("keeps minimap markers bounded for a 1,000-turn grouped timeline fixture", () => {
    const rows = Array.from({ length: 1_000 }, (_, turnIndex) => ({
      id: `turn-${turnIndex}`,
      groupedEntryIds: Array.from(
        { length: 5 },
        (_, entryIndex) => `turn-${turnIndex}-entry-${entryIndex}`,
      ),
    }));
    const entryRowIndices = buildTimelineEntryRowIndexMap(rows);
    const markers = sampleTimelineMinimapRowIndices({
      rowCount: rows.length,
      boundaryIndices: rows.map((_, index) => index),
      activeRowIndex: 843,
    });

    expect(entryRowIndices.size).toBe(6_000);
    expect(entryRowIndices.get("turn-843-entry-4")).toBe(843);
    expect(markers).toHaveLength(200);
    expect(markers[0]).toBe(0);
    expect(markers.at(-1)).toBe(999);
    expect(markers).toContain(843);
  });
});

describe("timeline turn rail", () => {
  it("anchors the answer rail at completed replies, excluding commentary and tools", () => {
    expect(
      deriveTimelineAssistantRailItems([
        { id: "u1", kind: "message", message: { role: "user", text: "Question" } },
        { id: "thought", kind: "message", message: { role: "assistant", text: "Checking…" } },
        { id: "tool", kind: "work" },
        {
          id: "answer",
          kind: "message",
          createdAt: "2026-03-17T19:12:00.000Z",
          showCompletionDivider: true,
          message: { role: "assistant", text: "Final answer" },
        },
        { id: "u2", kind: "message", message: { role: "user", text: "Follow-up" } },
        { id: "streaming", kind: "message", message: { role: "assistant", text: "In progress" } },
      ]),
    ).toEqual([
      {
        id: "answer",
        rowIndex: 3,
        createdAt: "2026-03-17T19:12:00.000Z",
        userText: "Question",
        assistantText: "Final answer",
      },
    ]);
  });
  it("resolves measured gutter geometry", () => {
    expect([47, 48, 0, Number.NaN].map(resolveTimelineTurnRailHasPersistentGutter)).toEqual([
      false,
      true,
      false,
      false,
    ]);
    expect([12, 26, 52, 1_000, 0, Number.NaN].map(resolveTimelineTurnRailHitStripWidth)).toEqual([
      8, 22, 40, 40, 0, 0,
    ]);
    expect(resolveTimelineTurnRailHeightStyle(5)).toBe("min(32px, 100%)");
    expect(resolveTimelineTurnRailTopPercent(0, 5)).toBe(0);
    expect(resolveTimelineTurnRailTopPercent(2, 5)).toBe(50);
    expect(resolveTimelineTurnRailTopPercent(4, 5)).toBe(100);
    expect(resolveTimelineTurnRailInteractiveWidth(14, false)).toBe(14);
    expect(resolveTimelineTurnRailInteractiveWidth(14, true)).toBe("22rem");
  });

  it("maps and clamps pointer positions", () => {
    const input = { itemCount: 5, railTop: 100, railHeight: 80, pointerY: 100 };
    expect(resolveTimelineTurnRailIndexFromPointer(input)).toBe(0);
    expect(resolveTimelineTurnRailIndexFromPointer({ ...input, pointerY: 140 })).toBe(2);
    expect(resolveTimelineTurnRailIndexFromPointer({ ...input, pointerY: 1_000 })).toBe(4);
    expect(resolveTimelineTurnRailIndexFromPointer({ ...input, pointerY: -1_000 })).toBe(0);
    expect(resolveTimelineTurnRailIndexFromPointer({ ...input, itemCount: 0 })).toBeNull();
  });

  it("selects the containing turn rather than the nearest following turn", () => {
    expect(resolveActiveTurnRailIndex([], 3)).toBe(-1);
    expect(resolveActiveTurnRailIndex([2, 10, 20], 10)).toBe(1);
    expect(resolveActiveTurnRailIndex([2, 10, 20], 17)).toBe(1);
    expect(resolveActiveTurnRailIndex([2, 10, 20], 0)).toBe(0);
    expect(resolveActiveTurnRailIndex([2, 10, 20], 99)).toBe(2);
  });

  it("derives user turns and their final assistant previews", () => {
    const items = deriveTimelineTurnRailItems([
      { id: "u1", kind: "message", message: { role: "user", text: "  First\n question " } },
      { id: "w1", kind: "work" },
      { id: "a1", kind: "message", message: { role: "assistant", text: "draft" } },
      { id: "a2", kind: "message", message: { role: "assistant", text: " Final\n answer " } },
      { id: "u2", kind: "message", message: { role: "user", text: "Second" } },
    ]);
    expect(items).toEqual([
      {
        id: "u1",
        rowIndex: 0,
        createdAt: null,
        userText: "First question",
        assistantText: "Final answer",
      },
      { id: "u2", rowIndex: 4, createdAt: null, userText: "Second", assistantText: null },
    ]);
  });

  it("previews an image-only turn by its images, not the prompt sent in their place", () => {
    const [item] = deriveTimelineTurnRailItems([
      {
        id: "u1",
        kind: "message",
        message: {
          role: "user",
          text: IMAGE_ONLY_BOOTSTRAP_PROMPT,
          attachments: [{ name: "login.png" }, { name: "error.png" }],
        },
      },
    ]);
    expect(item?.userText).toBe("login.png, error.png");
  });

  it("bounds previews and carries each turn's creation time", () => {
    const longAnswer = `${"word ".repeat(2_000)}TAIL_BEYOND_THE_SOURCE_LIMIT`;
    const [item] = deriveTimelineTurnRailItems([
      {
        id: "u1",
        kind: "message",
        createdAt: "2026-03-04T12:00:00.000Z",
        message: { role: "user", text: "Question" },
      },
      { id: "a1", kind: "message", message: { role: "assistant", text: longAnswer } },
    ]);
    expect(item?.createdAt).toBe("2026-03-04T12:00:00.000Z");
    expect(item?.assistantText?.length).toBe(TURN_RAIL_PREVIEW_DISPLAY_CHARS);
    expect(item?.assistantText?.endsWith("…")).toBe(true);
    expect(item?.assistantText).not.toContain("TAIL_BEYOND");
  });

  it("reuses previews for unchanged messages", () => {
    let reads = 0;
    const message = {
      role: "assistant" as const,
      get text() {
        reads += 1;
        return "Cached answer";
      },
    };
    const rows = [
      { id: "u1", kind: "message", message: { role: "user" as const, text: "Q" } },
      { id: "a1", kind: "message", message },
    ];
    deriveTimelineTurnRailItems(rows);
    const afterFirst = reads;
    expect(deriveTimelineTurnRailItems(rows)[0]?.assistantText).toBe("Cached answer");
    expect(reads).toBe(afterFirst);
  });

  it("strips terminal dumps and falls back through file and attachment names", () => {
    const terminalOnly = appendTerminalContextsToPrompt("Investigate this", [
      {
        terminalId: "terminal-1",
        terminalLabel: "Terminal 1",
        lineStart: 1,
        lineEnd: 2,
        text: "bun test\nlots of output",
      },
    ]);
    const fileOnly = appendAttachedFilesToPrompt("", [
      "C:/a/one.ts",
      "/b/two.ts",
      "three.ts",
      "four.ts",
    ]);
    const items = deriveTimelineTurnRailItems([
      { id: "context", kind: "message", message: { role: "user", text: terminalOnly } },
      { id: "files", kind: "message", message: { role: "user", text: fileOnly } },
      {
        id: "image",
        kind: "message",
        message: { role: "user", text: " ", attachments: [{ name: "screenshot.png" }] },
      },
      { id: "blank", kind: "message", message: { role: "user", text: " \n " } },
    ]);
    expect(items[0]?.userText).toBe("Investigate this");
    expect(items[1]?.userText).toBe("one.ts, two.ts, three.ts +1 more");
    expect(items[2]?.userText).toBe("screenshot.png");
    expect(items[3]?.userText).toBeNull();
  });
});

describe("Codex collaboration presentation", () => {
  it.each([
    ["spawnAgent", "Spawning agent", "Spawned agent", "Agent spawn failed"],
    [
      "sendInput",
      "Sending message to 2 agents",
      "Sent message to 2 agents",
      "Message delivery failed",
    ],
    ["resumeAgent", "Resuming agent", "Resumed agent", "Agent resume failed"],
    ["wait", "Waiting for 2 agents", "Finished waiting", "Agent wait failed"],
    ["closeAgent", "Closing agent", "Closed agent", "Agent close failed"],
  ] as const)("maps %s lifecycle headings", (tool, active, completed, failed) => {
    expect(resolveCodexCollaborationHeading(tool, "inProgress", 2)).toBe(active);
    expect(resolveCodexCollaborationHeading(tool, "completed", 2)).toBe(completed);
    expect(resolveCodexCollaborationHeading(tool, "failed", 2)).toBe(failed);
    expect(resolveCodexCollaborationHeading(tool, "declined", 2)).toBe(failed);
  });

  it("uses singular, plural, and receiver-free wording", () => {
    expect(resolveCodexCollaborationHeading("sendInput", "inProgress", 1)).toBe(
      "Sending message to 1 agent",
    );
    expect(resolveCodexCollaborationHeading("sendInput", "inProgress", 0)).toBe("Sending message");
    expect(resolveCodexCollaborationHeading("sendInput", "completed", 0)).toBe("Sent message");
    expect(resolveCodexCollaborationHeading("wait", "inProgress", 0)).toBe("Waiting for agents");
  });

  it("maps every agent status and retains receiver order", () => {
    expect(
      ["pendingInit", "running", "interrupted", "completed", "errored", "shutdown", "notFound"].map(
        (status) => resolveCodexCollaborationStatusLabel(status as never),
      ),
    ).toEqual([
      "Pending",
      "Running",
      "Interrupted",
      "Completed",
      "Errored",
      "Shut down",
      "Not found",
    ]);
    expect(
      deriveCodexCollaborationResponseRows(
        ["b", "a"],
        [
          { threadId: "a", status: "running" },
          { threadId: "b", status: "completed", message: "Done" },
          { threadId: "extra", status: "completed" },
        ],
      ).map((state) => state.threadId),
    ).toEqual(["b", "a"]);
  });
});

function workEntry(
  overrides: Partial<WorkEntryClassificationSource> = {},
): WorkEntryClassificationSource {
  return { label: "Tool call", tone: "tool", ...overrides } as WorkEntryClassificationSource;
}

describe("summarizeWorkGroup", () => {
  it("counts edited and read files and commands in a fixed order", () => {
    expect(
      summarizeWorkGroup([
        workEntry({ command: "bun run lint", itemType: "command_execution" }),
        workEntry({ requestKind: "file-read", readPaths: ["a.ts", "b.ts"] }),
        workEntry({ fileChangeId: "fc-1" as never, changedFiles: ["a.ts", "b.ts"] }),
        workEntry({ requestKind: "file-read" }),
        workEntry({ command: "bun fmt", itemType: "command_execution" }),
      ]),
    ).toBe("Edited 2 files · Read 3 files · Ran 2 commands");
  });

  it("uses singular nouns for single counts", () => {
    expect(
      summarizeWorkGroup([
        workEntry({ requestKind: "file-change" }),
        workEntry({ subagentType: "explore" }),
        workEntry({ tone: "error", label: "Failed" }),
      ]),
    ).toBe("Edited 1 file · 1 agent · 1 error");
  });

  it("names at most four buckets and counts the rest as more", () => {
    expect(
      summarizeWorkGroup([
        workEntry({ requestKind: "file-change" }),
        workEntry({ requestKind: "file-read" }),
        workEntry({ searchSummary: "foo in src" }),
        workEntry({ command: "ls", itemType: "command_execution" }),
        workEntry({ subagentType: "explore" }),
        workEntry({ label: "Fetch" }),
      ]),
    ).toBe("Edited 1 file · Read 1 file · 1 search · Ran 1 command · 2 more");
  });

  it("falls back to a step count when nothing is classifiable", () => {
    expect(summarizeWorkGroup([workEntry({ tone: "info" }), workEntry({ tone: "thinking" })])).toBe(
      "2 steps",
    );
  });
});

describe("findLastUserMessageRowIndex", () => {
  it("returns the newest user message row", () => {
    expect(
      findLastUserMessageRowIndex([
        { kind: "message", message: { role: "user" } },
        { kind: "work" },
        { kind: "message", message: { role: "assistant" } },
        { kind: "message", message: { role: "user" } },
        { kind: "work" },
      ]),
    ).toBe(3);
  });

  it("returns -1 without a user message", () => {
    expect(
      findLastUserMessageRowIndex([
        { kind: "work" },
        { kind: "message", message: { role: "assistant" } },
      ]),
    ).toBe(-1);
  });
});
