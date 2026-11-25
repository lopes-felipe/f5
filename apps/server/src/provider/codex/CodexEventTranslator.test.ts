import { EventId, ProviderInstanceId, ThreadId, type ProviderEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  MAX_MERGED_DELTA_BYTES,
  codexReasoningTokensSinceBaseline,
  codexThreadTokenUsageSnapshot,
  contentStreamKindFromMethod,
  hookTargetItemId,
  mergeContentDeltas,
  toTurnStatus,
} from "./CodexEventTranslator.ts";

describe("CodexEventTranslator", () => {
  it("extracts token usage snapshots and computes reasoning deltas safely", () => {
    const payload = {
      tokenUsage: {
        total: {
          inputTokens: 1200,
          cachedInputTokens: 300,
          outputTokens: 450,
          reasoningOutputTokens: 150,
          totalTokens: 1650,
        },
        last: {
          inputTokens: 500,
          outputTokens: 200,
          reasoningOutputTokens: 60,
          totalTokens: 700,
        },
        modelContextWindow: 200_000,
      },
    };
    const snapshot = codexThreadTokenUsageSnapshot(payload);
    expect(snapshot).toEqual({
      contextTokens: 700,
      modelContextWindowTokens: 200_000,
    });
    expect(codexReasoningTokensSinceBaseline(payload, 40)).toEqual({
      tokens: 110,
      baseline: 150,
    });
    expect(codexReasoningTokensSinceBaseline(payload, 200)).toEqual({
      tokens: 60,
      baseline: 150,
    });
  });

  it("maps Codex stream methods, hook target item ids, and turn statuses", () => {
    expect(contentStreamKindFromMethod("item/agentMessage/delta")).toBe("assistant_text");
    expect(contentStreamKindFromMethod("item/reasoning/summaryTextDelta")).toBe(
      "reasoning_summary_text",
    );
    expect(contentStreamKindFromMethod("item/commandExecution/outputDelta")).toBe("command_output");
    expect(hookTargetItemId("C:\\repo\\hook:exec-12345678-1234-1234-1234-123456789abc")).toBe(
      "exec-12345678-1234-1234-1234-123456789abc",
    );
    expect(hookTargetItemId("unmatched")).toBeUndefined();
    expect(toTurnStatus("interrupted")).toBe("interrupted");
    expect(toTurnStatus("failed")).toBe("failed");
    expect(toTurnStatus("completed")).toBe("completed");
  });

  it("coalesces content deltas and preserves single-part identity with 64 KiB cap constant", () => {
    expect(MAX_MERGED_DELTA_BYTES).toBe(64 * 1024);
    const first: ProviderEvent = {
      id: EventId.makeUnsafe("evt-1"),
      kind: "notification",
      provider: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: "2026-04-24T12:00:00.000Z",
      method: "item/agentMessage/delta",
      textDelta: "hello ",
      payload: { delta: "hello ", itemId: "item-1" },
    };

    expect(mergeContentDeltas(first, ["hello "])).toBe(first);
    const merged = mergeContentDeltas(first, ["hello ", "world"]);
    expect(merged.textDelta).toBe("hello world");
    expect((merged.payload as { delta: string }).delta).toBe("hello world");
  });
});
