import { describe, expect, it } from "vitest";
import {
  buildTimelineEntryRowIndexMap,
  computeMessageDurationStart,
  findNearestMinimapMarkerIndex,
  normalizeCompactToolLabel,
  sampleTimelineMinimapRowIndices,
} from "./MessagesTimeline.logic";

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
