import { describe, expect, it } from "vitest";

import {
  accumulateClaudeThinkingTokens,
  approximateContextCharsFromMessageContent,
  classifyRequestType,
  extractExitPlanModePlan,
  readClaudeCacheWriteSplit,
  sdkNativeMethod,
} from "./ClaudeTaskProjection.ts";

describe("ClaudeTaskProjection", () => {
  it("accumulates thinking tokens monotonically and reads cache write splits", () => {
    const first = accumulateClaudeThinkingTokens(undefined, 120);
    expect(first).toEqual({ lastEstimate: 120, pending: 120 });
    const second = accumulateClaudeThinkingTokens(first, 180);
    expect(second).toEqual({ lastEstimate: 180, pending: 180 });
    const withExplicitDelta = accumulateClaudeThinkingTokens(second, 200, 25);
    expect(withExplicitDelta).toEqual({ lastEstimate: 200, pending: 205 });

    expect(
      readClaudeCacheWriteSplit({
        "claude-opus-4-6": {
          cacheCreationEphemeral5mInputTokens: 100,
          cacheCreationEphemeral1hInputTokens: 250,
        },
      }),
    ).toEqual({ ephemeral5mInputTokens: 100, ephemeral1hInputTokens: 250 });
  });

  it("classifies tool requests, exit-plan payloads, context chars, and SDK native methods", () => {
    expect(classifyRequestType("Bash")).toBe("command_execution_approval");
    expect(classifyRequestType("Edit")).toBe("file_change_approval");
    expect(extractExitPlanModePlan({ plan: "  # Plan\n- step 1  " })).toBe("# Plan\n- step 1");
    expect(
      approximateContextCharsFromMessageContent([
        { type: "text", text: "hello" },
        { type: "image" },
      ]),
    ).toBe(21);
    expect(
      sdkNativeMethod({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta" } },
      } as never),
    ).toBe("claude/stream_event/content_block_delta/text_delta");
  });
});
