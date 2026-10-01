import {
  CommandId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ClientThreadTurnStartCommand,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  MAX_FAN_OUT_MODELS,
  fanOutGuardKey,
  runFanOut,
  toggleFanOutModel,
  type FanOutModel,
} from "./fanOut";

const model = (name: string): FanOutModel => ({
  instanceId: ProviderInstanceId.makeUnsafe("codex"),
  driver: ProviderDriverKind.make("codex"),
  model: name,
});
const draft = ThreadId.makeUnsafe("draft-thread");

function commandFor(threadId: ThreadId): ClientThreadTurnStartCommand {
  return {
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe(`command-${threadId}`),
    threadId,
    message: {
      messageId: MessageId.makeUnsafe(`m-${threadId}`),
      role: "user",
      text: "hi",
      attachments: [],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-10-01T00:00:00.000Z",
  } as ClientThreadTurnStartCommand;
}

describe("fan-out selection", () => {
  it("seeds with the current model, toggles off, and caps the selection", () => {
    let selection = toggleFanOutModel([], model("a"), model("b"));
    expect(selection.map((entry) => entry.model)).toEqual(["a", "b"]);
    selection = toggleFanOutModel(selection, model("a"), model("b"));
    expect(selection.map((entry) => entry.model)).toEqual(["a"]);
    for (const name of ["b", "c", "d", "e", "f", "g", "h"]) {
      selection = toggleFanOutModel(selection, model("a"), model(name));
    }
    expect(selection).toHaveLength(MAX_FAN_OUT_MODELS);
  });
});

describe("runFanOut", () => {
  it("starts each model in its own thread with at most three submits in flight", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let counter = 0;
    const guard = new Set<string>();
    const outcome = await runFanOut({
      draftThreadId: draft,
      targets: ["a", "b", "c", "d", "e"].map(model),
      guard,
      newThreadId: () => ThreadId.makeUnsafe(`child-${counter++}`),
      buildCommand: async (_target, threadId) => commandFor(threadId),
      submit: async (command) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return {
          disposition: "queued",
          submissionId: command.commandId,
          itemId: CommandId.makeUnsafe(`item-${command.threadId}`),
          snapshot: {} as never,
        };
      },
    });
    expect(outcome.started).toHaveLength(5);
    expect(new Set(outcome.started.map((entry) => entry.threadId)).size).toBe(5);
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(guard.size).toBe(5);
  });

  it("keeps successful children when others fail and skips them on retry", async () => {
    const guard = new Set<string>();
    let counter = 0;
    const submit = async (command: ClientThreadTurnStartCommand) => {
      if (command.threadId === "child-1") throw new Error("worktree unavailable");
      return { disposition: "started" as const, submissionId: command.commandId, sequence: 1 };
    };
    const first = await runFanOut({
      draftThreadId: draft,
      targets: [model("a"), model("b")],
      guard,
      newThreadId: () => ThreadId.makeUnsafe(`child-${counter++}`),
      buildCommand: async (_target, threadId) => commandFor(threadId),
      submit,
      concurrency: 1,
    });
    expect(first.started.map((entry) => entry.target.model)).toEqual(["a"]);
    expect(first.failed).toEqual([{ target: model("b"), message: "worktree unavailable" }]);
    expect(guard.has(fanOutGuardKey(draft, model("a")))).toBe(true);

    const retry = await runFanOut({
      draftThreadId: draft,
      targets: [model("a"), model("b")],
      guard,
      newThreadId: () => ThreadId.makeUnsafe(`child-${counter++}`),
      buildCommand: async (_target, threadId) => commandFor(threadId),
      submit,
      concurrency: 1,
    });
    expect(retry.skipped.map((entry) => entry.model)).toEqual(["a"]);
    expect(retry.started.map((entry) => entry.target.model)).toEqual(["b"]);
  });
});
