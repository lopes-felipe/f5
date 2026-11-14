import { beforeEach, describe, expect, it, vi } from "vitest";

const submit = vi.fn();

vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({ nextTurnQueue: { submit } }),
}));

import {
  type BackgroundThreadStartInput,
  buildBackgroundThreadStartCommand,
  resetBackgroundThreadStartForTests,
  startThreadInBackground,
} from "./startThreadInBackground";

const INPUT: BackgroundThreadStartInput = {
  project: { id: "project-1" as never, cwd: "/repo", model: "gpt-5", scripts: [] },
  text: "Fix the flaky test",
  provider: "claudeAgent",
  model: "claude-opus-4-6",
  modelSelection: { instanceId: "claude", model: "claude-opus-4-6" } as never,
  titleGenerationModel: "gpt-5-mini",
  titleGenerationModelSelection: { instanceId: "codex", model: "gpt-5-mini" } as never,
  runtimeMode: "approval-required",
  interactionMode: "plan",
  assistantDeliveryMode: "streaming",
  worktreeBaseBranch: null,
};

describe("buildBackgroundThreadStartCommand", () => {
  it("creates the thread inside the first send with the settings given", () => {
    const command = buildBackgroundThreadStartCommand(INPUT);
    expect(command).toMatchObject({
      type: "thread.turn.start",
      message: { role: "user", text: "Fix the flaky test", attachments: [] },
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      modelSelection: { instanceId: "claude", model: "claude-opus-4-6" },
      titleGenerationModel: "gpt-5-mini",
      titleSourceText: "Fix the flaky test",
      runtimeMode: "approval-required",
      interactionMode: "plan",
      assistantDeliveryMode: "streaming",
      bootstrap: {
        createThread: {
          projectId: "project-1",
          model: "claude-opus-4-6",
          modelSelection: { instanceId: "claude", model: "claude-opus-4-6" },
          runtimeMode: "approval-required",
          interactionMode: "plan",
          branch: null,
          worktreePath: null,
        },
      },
    });
    expect(command.bootstrap?.prepareWorktree).toBeUndefined();
    expect("modelOptions" in command).toBe(false);
    expect("providerOptions" in command).toBe(false);
  });

  it("asks for a worktree from the base branch", () => {
    const command = buildBackgroundThreadStartCommand({ ...INPUT, worktreeBaseBranch: "main" });
    expect(command.bootstrap).toMatchObject({
      createThread: { branch: "main", worktreePath: null },
      prepareWorktree: { projectCwd: "/repo", baseBranch: "main", requireWorktree: true },
    });
  });

  it("gives every thread its own ids", () => {
    const first = buildBackgroundThreadStartCommand(INPUT);
    const second = buildBackgroundThreadStartCommand(INPUT);
    expect(second.threadId).not.toBe(first.threadId);
    expect(second.commandId).not.toBe(first.commandId);
  });
});

describe("startThreadInBackground", () => {
  beforeEach(() => {
    submit.mockReset();
    resetBackgroundThreadStartForTests();
  });

  it("reports the thread it started", async () => {
    submit.mockResolvedValue({ disposition: "started", sequence: 1 });
    const result = await startThreadInBackground(INPUT);
    const sent = submit.mock.calls[0]![0];
    expect(sent.intent).toBe("auto");
    expect(sent.submissionId).toBe(sent.command.commandId);
    expect(result).toEqual({ threadId: sent.command.threadId, outcome: "started" });
  });

  it("rejects a send the server did not take", async () => {
    submit.mockResolvedValue({ disposition: "rejected", detail: "Provider is turned off." });
    await expect(startThreadInBackground(INPUT)).rejects.toThrow("Provider is turned off.");
  });

  it("resends the same submission after a lost response, so one thread starts", async () => {
    submit.mockRejectedValueOnce(new Error("WebSocket connection closed."));
    await expect(startThreadInBackground(INPUT)).rejects.toThrow("WebSocket connection closed.");
    submit.mockResolvedValue({ disposition: "started", sequence: 1 });
    await startThreadInBackground(INPUT);
    const [first, second] = submit.mock.calls.map((call) => call[0]);
    expect(second.submissionId).toBe(first.submissionId);
    expect(second.command.threadId).toBe(first.command.threadId);

    // Once confirmed, the same text starts another thread.
    await startThreadInBackground(INPUT);
    expect(submit.mock.calls[2]![0].command.threadId).not.toBe(first.command.threadId);
  });

  it("starts over when the text or settings changed after a lost response", async () => {
    submit.mockRejectedValueOnce(new Error("WebSocket connection closed."));
    await expect(startThreadInBackground(INPUT)).rejects.toThrow();
    submit.mockResolvedValue({ disposition: "started", sequence: 1 });
    await startThreadInBackground({ ...INPUT, text: "Fix the other test" });
    const [first, second] = submit.mock.calls.map((call) => call[0]);
    expect(second.command.threadId).not.toBe(first.command.threadId);
  });

  it("starts over after a failure the server reported", async () => {
    submit.mockRejectedValueOnce(new Error("Select a base branch."));
    await expect(startThreadInBackground(INPUT)).rejects.toThrow("Select a base branch.");
    submit.mockResolvedValue({ disposition: "started", sequence: 1 });
    await startThreadInBackground(INPUT);
    const [first, second] = submit.mock.calls.map((call) => call[0]);
    expect(second.submissionId).not.toBe(first.submissionId);
    expect(second.command.threadId).not.toBe(first.command.threadId);
  });
});
