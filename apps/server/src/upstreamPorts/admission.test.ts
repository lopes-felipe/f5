import { describe, expect, it } from "vitest";
import { buildPortRevisionCommand, portArgsHash } from "./admission.ts";
import { REVIEW_NOW, REVIEW_SLOTS, reviewThread } from "./testing/reviewFixtures.ts";

describe("port review admission", () => {
  const input = {
    topicIds: ["pr-1"],
    grouping: "together" as const,
    modelSelection: { instanceId: "codex" as never, model: "gpt-5" },
    runtimeMode: "full-access" as const,
  };
  it("retains old hashes for absent, undefined and null reviews", () => {
    expect(portArgsHash(input)).toBe(portArgsHash({ ...input, review: undefined }));
    expect(portArgsHash(input)).toBe(portArgsHash({ ...input, review: null }));
    expect(portArgsHash({ ...input, review: REVIEW_SLOTS })).not.toBe(portArgsHash(input));
    expect(portArgsHash({ ...input, review: REVIEW_SLOTS })).not.toBe(
      portArgsHash({
        ...input,
        review: {
          ...REVIEW_SLOTS,
          consolidation: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
        },
      }),
    );
  });
  it("uses current thread modes and model, without bootstrapping", () => {
    const thread = reviewThread({
      model: "claude-sonnet-4-5",
      modelSelection: { instanceId: "claude" as never, model: "claude-sonnet-4-5" },
      runtimeMode: "approval-required",
      interactionMode: "plan",
    });
    const command = buildPortRevisionCommand({
      thread,
      submissionId: "revision-1",
      prompt: "Fix",
      createdAt: REVIEW_NOW,
    });
    expect(command).toMatchObject({
      commandId: "revision-1",
      message: { messageId: "revision-1", attachments: [] },
      model: thread.model,
      modelSelection: thread.modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "plan",
    });
    expect(command.bootstrap).toBeUndefined();
  });
});
