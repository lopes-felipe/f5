import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  codexReasoningTokensSinceBaseline,
  codexThreadTokenUsageSnapshot,
  contentStreamKindFromMethod,
  hookTargetItemId,
  toTurnStatus,
} from "./CodexEventTranslator.ts";
import { mergeCodexProviderOptions, resolveCodexSelectionOptions } from "./CodexOptions.ts";

describe("CodexEventTranslator & CodexOptions", () => {
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

  it("prefers bound modelSelection options and merges codex launchArgs", () => {
    const instanceId = ProviderInstanceId.make("codex");
    const bound = resolveCodexSelectionOptions({
      boundInstanceId: instanceId,
      modelOptions: { codex: { reasoningEffort: "low", fastMode: true } },
      modelSelection: {
        instanceId,
        model: "gpt-5.3-codex",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    });
    expect(bound).toEqual({ reasoningEffort: "high" });

    const merged = mergeCodexProviderOptions(
      { codex: { launchArgs: ["--a"] } },
      { codex: { launchArgs: ["--b"] } },
    );
    expect(merged?.codex?.launchArgs).toEqual(["--a", "--b"]);
    expect(ThreadId.make("thread-1")).toBe("thread-1");
  });
});
