import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildCodexSampleParams,
  classifyCodexStderrLine,
  codexRequestTimeoutMs,
  isArchivedThreadResumeError,
  isRecoverableThreadResumeError,
  isSyntheticOneOffThreadId,
  mapCodexRuntimeMode,
  normalizeCodexModelSlug,
  readResumeCursorThreadId,
} from "./CodexProtocolHelpers.ts";

describe("CodexProtocolHelpers", () => {
  it("normalizes model slugs, runtime modes, and sample request params", () => {
    expect(normalizeCodexModelSlug("gpt-5.3-codex")).toBe("gpt-5.3-codex");
    expect(mapCodexRuntimeMode("full-access")).toEqual({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "danger-full-access",
    });
    expect(buildCodexSampleParams("t1", "turn-1", "hi", "high")).toEqual({
      threadId: "t1",
      expectedTurnId: "turn-1",
      prompt: "hi",
      effort: "high",
    });
  });

  it("classifies stderr lines, timeouts, synthetic one-off threads, and resume errors", () => {
    expect(codexRequestTimeoutMs("thread/start")).toBeGreaterThan(
      codexRequestTimeoutMs("turn/start"),
    );
    expect(isSyntheticOneOffThreadId(ThreadId.make("one-off:abc"))).toBe(true);
    expect(isSyntheticOneOffThreadId(ThreadId.make("thread-1"))).toBe(false);
    expect(readResumeCursorThreadId({ threadId: "prov-123" })).toBe("prov-123");
    expect(classifyCodexStderrLine("fatal: auth failed")).toEqual({
      message: "fatal: auth failed",
    });
    expect(
      isRecoverableThreadResumeError(new Error("thread/resume failed: rollout not found")),
    ).toBe(true);
    expect(isArchivedThreadResumeError(new Error("session sess-1 is archived"))).toBe(true);
  });
});
