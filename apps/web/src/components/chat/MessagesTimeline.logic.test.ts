import { describe, expect, it } from "vitest";
import {
  buildTimelineEntryRowIndexMap,
  computeMessageDurationStart,
  deriveTimelineTurnRailItems,
  findNearestMinimapMarkerIndex,
  normalizeCompactToolLabel,
  resolveActiveTurnRailIndex,
  resolveTimelineTurnRailHasPersistentGutter,
  resolveTimelineTurnRailHeightStyle,
  resolveTimelineTurnRailHitStripWidth,
  resolveTimelineTurnRailIndexFromPointer,
  resolveTimelineTurnRailInteractiveWidth,
  resolveTimelineTurnRailTopPercent,
  sampleTimelineMinimapRowIndices,
} from "./MessagesTimeline.logic";
import { appendAttachedFilesToPrompt } from "../../lib/attachedFiles";
import { appendTerminalContextsToPrompt } from "../../lib/terminalContext";

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
  it("resolves measured gutter geometry", () => {
    expect([47, 48, 0, Number.NaN].map(resolveTimelineTurnRailHasPersistentGutter)).toEqual([
      false,
      true,
      false,
      false,
    ]);
    expect([12, 26, 52, 1_000, 0, Number.NaN].map(resolveTimelineTurnRailHitStripWidth)).toEqual([
      0, 14, 40, 40, 0, 0,
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
      { id: "u1", rowIndex: 0, userText: "First question", assistantText: "Final answer" },
      { id: "u2", rowIndex: 4, userText: "Second", assistantText: null },
    ]);
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
