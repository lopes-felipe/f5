import {
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  USAGE_THREAD_TURNS_LIMIT,
  type UsageThreadTurn,
  type UsageThreadTurns,
  type UsageTurnFact,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../../types";
import {
  cacheMissesByAssistantMessageId,
  EMPTY_THREAD_TURNS,
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

/** A complete history: the window starts at the thread's first turn. */
function history(turns: ReadonlyArray<UsageThreadTurn>): UsageThreadTurns {
  return { turns, firstTurnId: turns[0]?.turnId ?? null, earlierTurnCount: 0 };
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
  it("restores Codex cache ratios and final-reply miss pills from loaded turn facts", () => {
    const loaded = history([
      codexTurn("cold", { inputTokens: 100, cacheReadTokens: 0, completedAt: minute(0) }),
      codexTurn("warm", { inputTokens: 100, cacheReadTokens: 80, completedAt: minute(2) }),
      codexTurn("miss", { inputTokens: 100, cacheReadTokens: 20, completedAt: minute(15) }),
      codexTurn("unknown", { cacheReadTokens: null, completedAt: minute(17) }),
    ]);
    const messages = [
      message("cold-reply", "assistant", minute(0), "cold"),
      message("warm-reply", "assistant", minute(2), "warm"),
      message("user", "user", minute(12)),
      message("interim", "assistant", minute(13), "miss"),
      message("final", "assistant", minute(15), "miss"),
      message("unknown-reply", "assistant", minute(17), "unknown"),
    ];
    const summary = summarizeThreadCache(loaded, turnStartTimes(messages));
    expect(summary.turns.map((turn) => turn.state)).toEqual([
      "cold-start",
      "warm",
      "miss",
      "unreported",
    ]);
    expect(formatCacheRatio(summary.turns[1]!.ratio!)).toBe("80%");
    const misses = cacheMissesByAssistantMessageId(summary, lastAssistantMessageIdByTurn(messages));
    expect([...misses.keys()]).toEqual([MessageId.makeUnsafe("final")]);
    expect(misses.get(MessageId.makeUnsafe("final"))).toMatchObject({
      rewrittenTokens: 80,
      idleMs: 10 * 60_000,
    });
  });

  it("counts Claude cache reads and writes outside input", () => {
    const [turn] = summarizeThreadCache(history([claudeTurn("a")]), noStarts).turns;
    // 900 / (10 + 900 + 90)
    expect(turn!.ratio).toBeCloseTo(0.9);
    expect(turn!.uncachedInputTokens).toBe(10);
    // Everything sent without a hit: uncached input plus what was written.
    expect(turn!.rewrittenTokens).toBe(100);
    expect(turn!.state).toBe("warm");
  });

  it("counts Pi like Claude, since Pi reports cache outside input", () => {
    // 60K read, 40K new: 60%, which the OpenAI-style formula would call 100%.
    const turns = [
      claudeTurn("a"),
      claudeTurn("b", {
        provider: "pi",
        inputTokens: 40_000,
        cacheReadTokens: 60_000,
        cacheWriteTokens: 0,
      }),
    ];
    const pi = summarizeThreadCache(history(turns), noStarts).turns[1]!;
    expect(pi.ratio).toBeCloseTo(0.6);
    expect(pi.uncachedInputTokens).toBe(40_000);
  });

  it("counts Codex cached input inside input", () => {
    const [turn] = summarizeThreadCache(history([codexTurn("a")]), noStarts).turns;
    expect(turn!.ratio).toBeCloseTo(0.8);
    expect(turn!.uncachedInputTokens).toBe(200);
    expect(turn!.rewrittenTokens).toBe(200);
  });

  it("puts the miss line just below one half", () => {
    const summary = summarizeThreadCache(
      history([
        claudeTurn("first"),
        // 50 / (50 + 0 + 50) = 0.5 exactly: warm.
        claudeTurn("half", { inputTokens: 50, cacheReadTokens: 50, cacheWriteTokens: 0 }),
        // 499 / 1000: a miss.
        codexTurn("below", { inputTokens: 1_000, cacheReadTokens: 499 }),
      ]),
      noStarts,
    );
    expect(summary.turns.map((turn) => turn.state)).toEqual(["warm", "warm", "miss"]);
  });

  it("never calls the thread's first turn a miss", () => {
    const summary = summarizeThreadCache(
      history([claudeTurn("a", { cacheReadTokens: 0, cacheWriteTokens: 5_000 }), claudeTurn("b")]),
      noStarts,
    );
    expect(summary.turns[0]!.state).toBe("cold-start");
    expect(summary.turns[1]!.state).toBe("warm");
  });

  it("judges the oldest loaded turn normally once the window has moved past the first", () => {
    const missed = claudeTurn("t501", { cacheReadTokens: 0, cacheWriteTokens: 5_000 });
    const summary = summarizeThreadCache(
      { turns: [missed, claudeTurn("t502")], firstTurnId: turnId("t1"), earlierTurnCount: 500 },
      noStarts,
    );
    expect(summary.turns[0]!.state).toBe("miss");
    expect(summary.turns.map((turn) => turn.turnNumber)).toEqual([501, 502]);
  });

  it("does not call a Claude turn that neither read nor wrote the cache a miss", () => {
    const summary = summarizeThreadCache(
      history([
        claudeTurn("a"),
        claudeTurn("off", { inputTokens: 4_000, cacheReadTokens: 0, cacheWriteTokens: 0 }),
      ]),
      noStarts,
    );
    expect(summary.turns[1]!.state).toBe("uncached");
    expect(summary.turns[1]!.rewrittenTokens).toBe(4_000);
  });

  it("marks turns without cache counts or input as unreported", () => {
    const summary = summarizeThreadCache(
      history([
        claudeTurn("a"),
        claudeTurn("null-read", { cacheReadTokens: null }),
        codexTurn("null-input", { inputTokens: null }),
        codexTurn("no-input", { inputTokens: 0, cacheReadTokens: 0 }),
      ]),
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
      history([
        claudeTurn("a", { inputTokens: 0, cacheReadTokens: 900, cacheWriteTokens: 100 }),
        codexTurn("b", { inputTokens: 1_000, cacheReadTokens: 0 }),
        codexTurn("c", { cacheReadTokens: null }),
      ]),
      noStarts,
    );
    expect(summary.overallRatio).toBeCloseTo(900 / 2_000);
    expect(summarizeThreadCache(EMPTY_THREAD_TURNS, noStarts)).toEqual({
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
    const summary = summarizeThreadCache(history(turns), starts);
    expect(summary.turns.map((turn) => turn.idleMs)).toEqual([null, null, 180 * 60_000]);

    const atFloor = summarizeThreadCache(history(turns), new Map([[turnId("b"), minute(5)]]));
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
      history([
        claudeTurn("t1"),
        claudeTurn("t2", { cacheReadTokens: 0, cacheWriteTokens: 1_000 }),
      ]),
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
    const start = history([
      claudeTurn("a", { completedAt: minute(1) }),
      claudeTurn("c", { completedAt: minute(9) }),
    ]);
    const merged = mergeThreadTurn(start, fact("b"));
    expect(merged.turns.map((turn) => turn.turnId)).toEqual(["a", "b", "c"]);
    expect(merged.firstTurnId).toBe("a");
    expect(merged.turns[1]).toEqual({
      turnId: "b",
      provider: "claudeAgent",
      model: "claude-opus-5-5",
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      totalTokens: 10,
      tokenProvenance: "provider-reported",
      completedAt: minute(5),
    });
    const replaced = mergeThreadTurn(
      merged,
      fact("b", { cacheReadTokens: 99, completedAt: minute(6) }),
    );
    expect(replaced.turns.map((turn) => [turn.turnId, turn.cacheReadTokens])).toEqual([
      ["a", 900],
      ["b", 99],
      ["c", 900],
    ]);
  });

  it("ignores asides and older facts for a turn it already has", () => {
    const start = history([claudeTurn("a", { completedAt: minute(5) })]);
    expect(mergeThreadTurn(start, fact("a", { completedAt: minute(1) }))).toBe(start);
    expect(mergeThreadTurn(start, fact("aside:event-1", { completedAt: minute(9) }))).toBe(start);
  });

  it("takes the first live fact of an empty thread as its first turn", () => {
    const merged = mergeThreadTurn(EMPTY_THREAD_TURNS, fact("first"));
    expect(merged.firstTurnId).toBe("first");
    // It read 3 of 8 input tokens from cache, which is exempt as the first turn.
    expect(summarizeThreadCache(merged, noStarts).turns[0]!.state).toBe("cold-start");
  });

  it("keeps only the newest turns and counts the rest as earlier", () => {
    const turns = Array.from({ length: USAGE_THREAD_TURNS_LIMIT }, (_, index) =>
      claudeTurn(`t${String(index).padStart(4, "0")}`, { completedAt: minute(index) }),
    );
    const merged = mergeThreadTurn(
      history(turns),
      fact("newest", { completedAt: minute(USAGE_THREAD_TURNS_LIMIT + 1) }),
    );
    expect(merged.turns).toHaveLength(USAGE_THREAD_TURNS_LIMIT);
    expect(merged.turns[0]!.turnId).toBe("t0001");
    expect(merged.turns.at(-1)!.turnId).toBe("newest");
    expect(merged.firstTurnId).toBe("t0000");
    expect(merged.earlierTurnCount).toBe(1);
  });
});

describe("formatCacheRatio", () => {
  it("only shows 100% when nothing missed", () => {
    expect(formatCacheRatio(1)).toBe("100%");
    expect(formatCacheRatio(0.996)).toBe("99%");
    expect(formatCacheRatio(0.034)).toBe("3%");
  });
});
