import {
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  USAGE_THREAD_TURNS_LIMIT,
  type UsageThreadTurn,
  type UsageTurnFact,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../../types";
import {
  cacheMissesByAssistantMessageId,
  decodeStringMap,
  encodeStringMap,
  formatCacheRatio,
  formatIdle,
  lastAssistantMessageIdByTurn,
  mergeThreadTurn,
  summarizeThreadCache,
  turnStartTimes,
} from "./cacheIndicator.logic";

const turnId = (id: string) => TurnId.makeUnsafe(id);
const minute = (value: number) =>
  new Date(Date.UTC(2026, 10, 13, 10, 0) + value * 60_000).toISOString();

function claudeTurn(id: string, overrides: Partial<UsageThreadTurn> = {}): UsageThreadTurn {
  return {
    turnId: turnId(id),
    provider: "claudeAgent",
    model: "claude-opus-5-5",
    inputTokens: 10,
    outputTokens: 100,
    cacheReadTokens: 900,
    cacheWriteTokens: 90,
    completedAt: minute(0),
    ...overrides,
  };
}

function codexTurn(id: string, overrides: Partial<UsageThreadTurn> = {}): UsageThreadTurn {
  return {
    turnId: turnId(id),
    provider: "codex",
    model: "gpt-6.1",
    inputTokens: 1_000,
    outputTokens: 50,
    cacheReadTokens: 800,
    cacheWriteTokens: null,
    completedAt: minute(0),
    ...overrides,
  };
}

function message(
  id: string,
  role: ChatMessage["role"],
  createdAt: string,
  turn: string | null = null,
): ChatMessage {
  return {
    id: MessageId.makeUnsafe(id),
    role,
    text: id,
    turnId: turn ? turnId(turn) : null,
    createdAt,
    streaming: false,
  };
}

const noStarts = new Map<TurnId, string>();

describe("summarizeThreadCache ratios", () => {
  it("counts Claude cache reads and writes outside input", () => {
    const [turn] = summarizeThreadCache([claudeTurn("a")], noStarts).turns;
    // 900 / (10 + 900 + 90)
    expect(turn!.ratio).toBeCloseTo(0.9);
    expect(turn!.uncachedInputTokens).toBe(10);
    expect(turn!.rewrittenTokens).toBe(90);
    expect(turn!.state).toBe("warm");
  });

  it("counts Codex cached input inside input", () => {
    const [turn] = summarizeThreadCache([codexTurn("a")], noStarts).turns;
    expect(turn!.ratio).toBeCloseTo(0.8);
    expect(turn!.uncachedInputTokens).toBe(200);
    expect(turn!.rewrittenTokens).toBe(200);
  });

  it("puts the miss line just below one half", () => {
    const summary = summarizeThreadCache(
      [
        claudeTurn("first"),
        // 50 / (50 + 0 + 50) = 0.5 exactly: warm.
        claudeTurn("half", { inputTokens: 50, cacheReadTokens: 50, cacheWriteTokens: 0 }),
        // 499 / 1000: a miss.
        codexTurn("below", { inputTokens: 1_000, cacheReadTokens: 499 }),
      ],
      noStarts,
    );
    expect(summary.turns.map((turn) => turn.state)).toEqual(["warm", "warm", "miss"]);
  });

  it("never calls the first recorded turn a miss", () => {
    const summary = summarizeThreadCache(
      [claudeTurn("a", { cacheReadTokens: 0, cacheWriteTokens: 5_000 }), claudeTurn("b")],
      noStarts,
    );
    expect(summary.turns[0]!.state).toBe("cold-start");
    expect(summary.turns[1]!.state).toBe("warm");
  });

  it("marks turns without cache counts or input as unreported", () => {
    const summary = summarizeThreadCache(
      [
        claudeTurn("a"),
        claudeTurn("null-read", { cacheReadTokens: null }),
        codexTurn("null-input", { inputTokens: null }),
        codexTurn("no-input", { inputTokens: 0, cacheReadTokens: 0 }),
      ],
      noStarts,
    );
    expect(summary.turns.map((turn) => turn.state)).toEqual([
      "warm",
      "unreported",
      "unreported",
      "unreported",
    ]);
    expect(summary.turns[1]!.ratio).toBeNull();
    expect(summary.turns[1]!.rewrittenTokens).toBeNull();
  });

  it("weights the overall ratio by input and skips unreported turns", () => {
    const summary = summarizeThreadCache(
      [
        claudeTurn("a", { inputTokens: 0, cacheReadTokens: 900, cacheWriteTokens: 100 }),
        codexTurn("b", { inputTokens: 1_000, cacheReadTokens: 0 }),
        codexTurn("c", { cacheReadTokens: null }),
      ],
      noStarts,
    );
    expect(summary.overallRatio).toBeCloseTo(900 / 2_000);
    expect(summarizeThreadCache([], noStarts)).toEqual({
      turns: [],
      overallRatio: null,
      last: null,
    });
  });
});

describe("idle gaps", () => {
  it("measures from the previous turn's end to this turn's start, from five minutes", () => {
    const turns = [
      claudeTurn("a", { completedAt: minute(0) }),
      claudeTurn("b", { completedAt: minute(10) }),
      claudeTurn("c", { completedAt: minute(200) }),
    ];
    const starts = new Map([
      [turnId("b"), minute(4)],
      [turnId("c"), minute(10 + 180)],
    ]);
    const summary = summarizeThreadCache(turns, starts);
    expect(summary.turns.map((turn) => turn.idleMs)).toEqual([null, null, 180 * 60_000]);

    const atFloor = summarizeThreadCache(turns, new Map([[turnId("b"), minute(5)]]));
    expect(atFloor.turns[1]!.idleMs).toBe(5 * 60_000);
  });

  it("formats the gap roughly", () => {
    expect(formatIdle(5 * 60_000)).toBe("5m");
    expect(formatIdle(59 * 60_000 + 59_000)).toBe("59m");
    expect(formatIdle(3 * 3_600_000 + 1)).toBe("3h");
    expect(formatIdle(50 * 3_600_000)).toBe("2d");
  });

  it("starts a turn at the user message before its first reply", () => {
    const starts = turnStartTimes([
      message("u1", "user", minute(0)),
      message("a1", "assistant", minute(1), "t1"),
      message("a1b", "assistant", minute(2), "t1"),
      // An automated turn with no user message starts at its own reply.
      message("a2", "assistant", minute(5), "t2"),
      message("u3", "user", minute(9)),
      message("a3", "assistant", minute(10), "t3"),
    ]);
    expect(Object.fromEntries(starts)).toEqual({
      t1: minute(0),
      t2: minute(5),
      t3: minute(9),
    });
  });
});

describe("cacheMissesByAssistantMessageId", () => {
  it("keys each missed turn by the turn's last assistant message", () => {
    const summary = summarizeThreadCache(
      [claudeTurn("t1"), claudeTurn("t2", { cacheReadTokens: 0, cacheWriteTokens: 1_000 })],
      noStarts,
    );
    const messageIdByTurn = lastAssistantMessageIdByTurn([
      message("u1", "user", minute(0)),
      message("a1", "assistant", minute(1), "t1"),
      message("u2", "user", minute(2)),
      message("a2", "assistant", minute(3), "t2"),
      message("a2-last", "assistant", minute(4), "t2"),
    ]);
    const misses = cacheMissesByAssistantMessageId(summary, messageIdByTurn);
    expect([...misses.keys()]).toEqual(["a2-last"]);
    expect(misses.get(MessageId.makeUnsafe("a2-last"))!.turnId).toBe("t2");
  });
});

describe("mergeThreadTurn", () => {
  const fact = (id: string, overrides: Partial<UsageTurnFact> = {}): UsageTurnFact => ({
    turnId: turnId(id),
    threadId: ThreadId.makeUnsafe("thread"),
    projectId: ProjectId.makeUnsafe("project"),
    provider: "claudeAgent",
    providerInstanceId: null,
    model: "claude-opus-5-5",
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
    totalTokens: 10,
    providerReportedCostUsd: null,
    tokenProvenance: "provider-reported",
    costProvenance: "unreported",
    completedAt: minute(5),
    sourceEventId: EventId.makeUnsafe(`event-${id}`),
    ...overrides,
  });

  it("inserts in completion order and replaces the same turn", () => {
    const turns = [
      claudeTurn("a", { completedAt: minute(1) }),
      claudeTurn("c", { completedAt: minute(9) }),
    ];
    const merged = mergeThreadTurn(turns, fact("b"));
    expect(merged.map((turn) => turn.turnId)).toEqual(["a", "b", "c"]);
    expect(merged[1]).toEqual({
      turnId: "b",
      provider: "claudeAgent",
      model: "claude-opus-5-5",
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      completedAt: minute(5),
    });
    const replaced = mergeThreadTurn(
      merged,
      fact("b", { cacheReadTokens: 99, completedAt: minute(6) }),
    );
    expect(replaced.map((turn) => [turn.turnId, turn.cacheReadTokens])).toEqual([
      ["a", 900],
      ["b", 99],
      ["c", 900],
    ]);
  });

  it("ignores an older fact for a turn it already has", () => {
    const turns = [claudeTurn("a", { completedAt: minute(5) })];
    expect(mergeThreadTurn(turns, fact("a", { completedAt: minute(1) }))).toBe(turns);
  });

  it("keeps only the newest turns", () => {
    const turns = Array.from({ length: USAGE_THREAD_TURNS_LIMIT }, (_, index) =>
      claudeTurn(`t${String(index).padStart(4, "0")}`, { completedAt: minute(index) }),
    );
    const merged = mergeThreadTurn(
      turns,
      fact("newest", { completedAt: minute(USAGE_THREAD_TURNS_LIMIT + 1) }),
    );
    expect(merged).toHaveLength(USAGE_THREAD_TURNS_LIMIT);
    expect(merged[0]!.turnId).toBe("t0001");
    expect(merged.at(-1)!.turnId).toBe("newest");
  });
});

describe("string map encoding", () => {
  it("round-trips entries in order", () => {
    const map = new Map([
      ["turn-b", "2026-11-13T10:00:00.000Z"],
      ["turn-a", "2026-11-13T09:00:00.000Z"],
    ]);
    const encoded = encodeStringMap(map);
    expect(encodeStringMap(new Map(map))).toBe(encoded);
    expect([...decodeStringMap(encoded)]).toEqual([...map]);
    expect(decodeStringMap("").size).toBe(0);
  });
});

describe("formatCacheRatio", () => {
  it("only shows 100% when nothing missed", () => {
    expect(formatCacheRatio(1)).toBe("100%");
    expect(formatCacheRatio(0.996)).toBe("99%");
    expect(formatCacheRatio(0.034)).toBe("3%");
  });
});
