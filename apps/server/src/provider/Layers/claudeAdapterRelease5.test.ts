import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import {
  CLAUDE_SEARCH_TIMED_OUT_NOTE,
  buildClaudeQueryEnv,
  claudeAskUserQuestionAnnotations,
  claudeStartupFailureMessage,
  claudeToolResultNote,
  readClaudeCacheWriteSplit,
} from "./ClaudeAdapter.ts";

const startupFailure = (reason: string | undefined, subtype = "error_during_execution") =>
  ({
    type: "result",
    subtype,
    errors: ["raw startup error"],
    ...(reason ? { startup_failure_reason: reason } : {}),
  }) as unknown as SDKResultMessage;

describe("claudeStartupFailureMessage", () => {
  it("maps F5-fixable startup reasons and keeps Claude's message otherwise", () => {
    expect(claudeStartupFailureMessage(startupFailure("sandbox_required_unavailable"))).toContain(
      "working sandbox",
    );
    expect(claudeStartupFailureMessage(startupFailure("initialize_not_first"))).toContain(
      "custom launch arguments",
    );
    expect(claudeStartupFailureMessage(startupFailure("some_new_reason"))).toBeUndefined();
    expect(claudeStartupFailureMessage(startupFailure(undefined))).toBeUndefined();
    expect(
      claudeStartupFailureMessage(startupFailure("initialize_not_first", "error_max_turns")),
    ).toBeUndefined();
  });
});

describe("claudeAskUserQuestionAnnotations", () => {
  const ids = ["Pick a color?", "Pick a size?"];

  it("marks every question dismissed when nothing was answered", () => {
    expect(claudeAskUserQuestionAnnotations(ids, {}, true)).toEqual({
      "Pick a color?": { unanswered: "dismissed" },
      "Pick a size?": { unanswered: "dismissed" },
    });
    expect(claudeAskUserQuestionAnnotations(ids, { "Pick a color?": "  " }, true)).toEqual({
      "Pick a color?": { unanswered: "dismissed" },
      "Pick a size?": { unanswered: "dismissed" },
    });
  });

  it("marks only blank questions skipped on a partial submit and nothing on a full one", () => {
    expect(claudeAskUserQuestionAnnotations(ids, { "Pick a color?": "Red" }, true)).toEqual({
      "Pick a size?": { unanswered: "skipped" },
    });
    expect(
      claudeAskUserQuestionAnnotations(ids, { "Pick a color?": "Red", "Pick a size?": "M" }, true),
    ).toBeUndefined();
  });

  it("sends nothing to a CLI without ask_user_question_unanswered_v1", () => {
    expect(claudeAskUserQuestionAnnotations(ids, {}, false)).toBeUndefined();
  });
});

describe("claudeToolResultNote", () => {
  const format = (epochMs: number) => `t=${epochMs}`;

  it("flags Grep/Glob searches that stopped at the time limit", () => {
    expect(claudeToolResultNote("Grep", { timedOut: true })).toBe(CLAUDE_SEARCH_TIMED_OUT_NOTE);
    expect(claudeToolResultNote("Glob", { timedOut: true })).toBe(CLAUDE_SEARCH_TIMED_OUT_NOTE);
    expect(claudeToolResultNote("Grep", { timedOut: false })).toBeUndefined();
    expect(claudeToolResultNote("Read", { timedOut: true })).toBeUndefined();
  });

  it("shows the next run of a created job and the soonest listed job", () => {
    expect(claudeToolResultNote("CronCreate", { nextFireAt: 2_000 }, format)).toBe(
      "Next run: t=2000",
    );
    expect(
      claudeToolResultNote(
        "CronList",
        { jobs: [{ nextFireAt: 9_000 }, { id: "paused" }, { nextFireAt: 3_000 }] },
        format,
      ),
    ).toBe("Next run: t=3000");
    expect(claudeToolResultNote("CronList", { jobs: [] }, format)).toBeUndefined();
    expect(claudeToolResultNote("CronCreate", undefined, format)).toBeUndefined();
  });
});

describe("readClaudeCacheWriteSplit", () => {
  it("sums the 5-minute and 1-hour cache writes across models", () => {
    expect(
      readClaudeCacheWriteSplit({
        "claude-opus-5-5": {
          cacheCreationEphemeral5mInputTokens: 100,
          cacheCreationEphemeral1hInputTokens: 2_000,
        },
        "claude-haiku-5-5": { cacheCreationEphemeral5mInputTokens: 50 },
      }),
    ).toEqual({ ephemeral5mInputTokens: 150, ephemeral1hInputTokens: 2_000 });
  });

  it("is undefined when no model reports the split", () => {
    expect(readClaudeCacheWriteSplit({ "claude-opus-5-5": { inputTokens: 10 } })).toBeUndefined();
    expect(
      readClaudeCacheWriteSplit({ model: { cacheCreationEphemeral5mInputTokens: -1 } }),
    ).toBeUndefined();
    expect(readClaudeCacheWriteSplit(undefined)).toBeUndefined();
  });
});

describe("buildClaudeQueryEnv sub-agent effort", () => {
  it("sets CLAUDE_CODE_SUBAGENT_EFFORT only when chosen and lets the operator env win", () => {
    expect(buildClaudeQueryEnv({}, {})).not.toHaveProperty("CLAUDE_CODE_SUBAGENT_EFFORT");
    expect(buildClaudeQueryEnv({ subagentEffort: "high" }, {}).CLAUDE_CODE_SUBAGENT_EFFORT).toBe(
      "high",
    );
    expect(
      buildClaudeQueryEnv({ subagentEffort: "high" }, { CLAUDE_CODE_SUBAGENT_EFFORT: "low" })
        .CLAUDE_CODE_SUBAGENT_EFFORT,
    ).toBe("low");
  });
});
