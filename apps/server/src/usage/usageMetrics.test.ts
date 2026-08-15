import { describe, expect, it } from "vitest";

import { EventId, ThreadId, TurnId } from "@t3tools/contracts";

import { normalizeTurnUsage } from "./usageMetrics.ts";

const baseEvent = {
  type: "turn.completed" as const,
  eventId: EventId.makeUnsafe("usage-event"),
  threadId: ThreadId.makeUnsafe("thread-1"),
  turnId: TurnId.makeUnsafe("turn-1"),
  createdAt: "2026-08-15T10:00:00.000Z",
  payload: { state: "completed" as const },
  providerRefs: {},
};

describe("normalizeTurnUsage", () => {
  it("keeps Claude cache fields separate and includes them in a derived total", () => {
    const usage = normalizeTurnUsage({
      ...baseEvent,
      provider: "claudeAgent",
      payload: {
        state: "completed",
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 300,
          cache_creation_input_tokens: 40,
        },
        totalCostUsd: 0.25,
      },
    });

    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 300,
      cacheWriteTokens: 40,
      totalTokens: 460,
      providerReportedCostUsd: 0.25,
      tokenProvenance: "derived-from-provider-fields",
      costProvenance: "provider-reported",
    });
  });

  it("does not double count cached Codex input and respects a reported total", () => {
    const usage = normalizeTurnUsage({
      ...baseEvent,
      provider: "codex",
      payload: {
        state: "completed",
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cachedInputTokens: 80,
          totalTokens: 120,
        },
      },
    });

    expect(usage.totalTokens).toBe(120);
    expect(usage.cacheReadTokens).toBe(80);
    expect(usage.tokenProvenance).toBe("provider-reported");
    expect(usage.providerReportedCostUsd).toBeNull();
  });

  it("aggregates per-model provider fields without inventing a price", () => {
    const usage = normalizeTurnUsage({
      ...baseEvent,
      provider: "claudeAgent",
      payload: {
        state: "completed",
        modelUsage: {
          opus: { inputTokens: 10, outputTokens: 4, cacheReadInputTokens: 20 },
          haiku: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 3 },
        },
      },
    });

    expect(usage.inputTokens).toBe(15);
    expect(usage.outputTokens).toBe(5);
    expect(usage.cacheReadTokens).toBe(23);
    expect(usage.totalTokens).toBe(43);
    expect(usage.costProvenance).toBe("unreported");
  });

  it("records an explicit unreported fact when a provider has no metrics", () => {
    const usage = normalizeTurnUsage({
      ...baseEvent,
      provider: "cursor",
    });

    expect(usage.totalTokens).toBeNull();
    expect(usage.providerReportedCostUsd).toBeNull();
    expect(usage.tokenProvenance).toBe("unreported");
    expect(usage.costProvenance).toBe("unreported");
  });
});
