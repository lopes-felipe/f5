import {
  EventId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { CodexTurnUsage } from "./codexTurnUsage.ts";
import { normalizeTurnUsage } from "../usage/usageMetrics.ts";

const counts = (inputTokens: number, cachedInputTokens: number, outputTokens = 10) => ({
  inputTokens,
  cachedInputTokens,
  outputTokens,
});
const event = (method: string, payload: unknown = {}, turnId = "t1"): ProviderEvent => ({
  id: EventId.makeUnsafe("event"),
  kind: "notification",
  provider: "codex",
  threadId: ThreadId.makeUnsafe("thread"),
  turnId: TurnId.makeUnsafe(turnId),
  createdAt: "2026-11-14T00:00:00.000Z",
  method,
  payload: { threadId: "native", ...(payload as object) },
});
const frame = (total: unknown, last: unknown, turnId = "t1") =>
  event("thread/tokenUsage/updated", { tokenUsage: { total, last } }, turnId);

describe("CodexTurnUsage", () => {
  it("ignores terminal notifications without an active turn or turn identity", () => {
    const usage = new CodexTurnUsage();
    const { turnId: _turnId, ...unidentified } = event("turn/completed");
    expect(usage.observe(unidentified)).toBeUndefined();
    expect(usage.observe(event("turn/aborted"))).toBeUndefined();
  });

  it("aggregates requests, deduplicates frames, and retains baselines across turns", () => {
    const usage = new CodexTurnUsage();
    usage.observe(event("turn/started"));
    usage.observe(frame(counts(10_000, 8_000, 500), counts(100, 80)));
    usage.observe(frame(counts(10_000, 8_000, 500), counts(100, 80)));
    usage.observe(frame(counts(10_200, 8_100, 520), counts(200, 100, 20)));
    expect(usage.observe(event("turn/completed"))).toEqual(counts(300, 180, 30));
    expect(usage.observe(event("turn/completed"))).toBeUndefined();
    usage.observe(event("turn/started", {}, "t2"));
    usage.observe(frame(counts(10_500, 8_350, 550), counts(300, 250, 30), "t2"));
    expect(usage.observe(event("turn/completed", {}, "t2"))).toEqual(counts(300, 250, 30));
  });

  it("uses idle resume snapshots only as a baseline and resets all counters together", () => {
    const usage = new CodexTurnUsage();
    usage.observe(event("thread/started"));
    usage.observe(frame(counts(10_000, 20, 500), counts(1_000, 10)));
    usage.observe(event("turn/started"));
    usage.observe(frame(counts(100, 80, 10), counts(100, 80)));
    expect(usage.observe(event("turn/completed"))).toEqual(counts(100, 80));
  });

  it("does not fabricate missing, invalid, last-only, or overflowing metrics", () => {
    const usage = new CodexTurnUsage();
    usage.observe(event("turn/started"));
    usage.observe(
      frame({ inputTokens: 100, outputTokens: 10 }, { inputTokens: 100, outputTokens: 10 }),
    );
    usage.observe(frame(counts(200, 80, 20), counts(100, 80)));
    expect(usage.observe(event("turn/completed"))).toEqual({ inputTokens: 200, outputTokens: 20 });
    usage.observe(event("turn/started", {}, "t2"));
    usage.observe(frame({ inputTokens: -1, cachedInputTokens: NaN }, counts(100, 80), "t2"));
    expect(usage.observe(event("turn/completed", {}, "t2"))).toBeUndefined();
    usage.observe(event("turn/started", {}, "t3"));
    usage.observe(frame(undefined, counts(100, 80), "t3"));
    usage.observe(frame(undefined, counts(100, 80), "t3"));
    expect(usage.observe(event("turn/completed", {}, "t3"))).toBeUndefined();
    usage.observe(event("turn/started", {}, "t4"));
    usage.observe(
      frame(counts(Number.MAX_SAFE_INTEGER, 0), counts(Number.MAX_SAFE_INTEGER, 0), "t4"),
    );
    usage.observe(frame(counts(1, 0), counts(1, 0), "t4"));
    expect(usage.observe(event("turn/completed", {}, "t4"))?.inputTokens).toBeUndefined();
  });

  it("isolates native child agents, stale turns, threads, instances, and generations", () => {
    const usage = new CodexTurnUsage();
    usage.observe(event("turn/started"));
    usage.observe(frame(counts(100, 80), counts(100, 80)));
    usage.observe(event("turn/started", { threadId: "child" }, "child-turn"));
    usage.observe({
      ...frame(counts(900, 0), counts(900, 0)),
      payload: {
        threadId: "child",
        tokenUsage: { total: counts(900, 0), last: counts(900, 0) },
      },
    });
    usage.observe(frame(counts(900, 0), counts(900, 0), "old-turn"));
    for (const identity of [
      { threadId: ThreadId.makeUnsafe("other") },
      { providerInstanceId: ProviderInstanceId.makeUnsafe("other") },
      { sessionGeneration: 2 },
    ]) {
      usage.observe({ ...event("turn/started"), ...identity });
      usage.observe({ ...frame(counts(900, 0), counts(900, 0)), ...identity });
      expect(usage.observe({ ...event("turn/completed"), ...identity })).toEqual(counts(900, 0));
    }
    expect(usage.observe(event("turn/completed"))).toEqual(counts(100, 80));
  });

  it("clears active turns on abort and baselines on session closure", () => {
    const usage = new CodexTurnUsage();
    usage.observe(event("turn/started"));
    usage.observe(frame(counts(100, 80), counts(100, 80)));
    usage.observe(event("turn/aborted"));
    expect(usage.observe(event("turn/completed"))).toBeUndefined();
    usage.observe(event("session/closed"));
    usage.observe(event("turn/started"));
    usage.observe(frame(counts(10_000, 8_000), counts(100, 80)));
    expect(usage.observe(event("turn/completed"))).toEqual(counts(100, 80));
  });

  it("normalizes computed counts as derived usage without double counting cache reads", () => {
    const usage = new CodexTurnUsage();
    usage.observe(event("turn/started"));
    usage.observe(frame(counts(100, 80), counts(100, 80)));
    expect(
      normalizeTurnUsage({
        type: "turn.completed",
        eventId: EventId.makeUnsafe("completed"),
        provider: "codex",
        threadId: ThreadId.makeUnsafe("thread"),
        turnId: TurnId.makeUnsafe("t1"),
        createdAt: "2026-11-14T00:00:00.000Z",
        payload: { state: "completed", usage: usage.observe(event("turn/completed")) },
      }),
    ).toMatchObject({
      inputTokens: 100,
      cacheReadTokens: 80,
      outputTokens: 10,
      totalTokens: 110,
      tokenProvenance: "derived-from-provider-fields",
    });
  });
});
