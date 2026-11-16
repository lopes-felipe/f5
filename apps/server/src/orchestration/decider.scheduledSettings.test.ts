import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-08-15T09:00:00.000Z";
const THREAD = ThreadId.makeUnsafe("thread-bound");

const readModel = () =>
  Effect.runPromise(
    projectEvent(createEmptyReadModel(NOW), {
      sequence: 1,
      eventId: EventId.makeUnsafe("event-create"),
      aggregateKind: "thread",
      aggregateId: THREAD,
      type: "thread.created",
      occurredAt: NOW,
      commandId: CommandId.makeUnsafe("command-create"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("command-create"),
      metadata: {},
      payload: {
        threadId: THREAD,
        projectId: ProjectId.makeUnsafe("project"),
        title: "Conversation",
        model: "gpt-5-codex",
        interactionMode: "default",
        // The user restricted access after the scheduled turn was admitted.
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    }),
  );
const turnStart = (extra: Partial<Extract<OrchestrationCommand, { type: "thread.turn.start" }>>) =>
  ({
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe("command-scheduled"),
    threadId: THREAD,
    message: {
      messageId: MessageId.makeUnsafe("message-scheduled"),
      role: "user",
      text: "Scheduled prompt",
      attachments: [],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    dispatchSource: "next-turn-queue",
    createdAt: NOW,
    ...extra,
  }) as OrchestrationCommand;

describe("thread-bound scheduled turns", () => {
  it("are rejected at acceptance instead of restoring the admitted settings", async () => {
    const model = await readModel();
    const exit = await Effect.runPromiseExit(
      decideOrchestrationCommand({
        readModel: model,
        command: turnStart({ requireCurrentSettings: true }),
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("ThreadSettingsChangedError");
    // Ordinary queued turns still restore their own settings.
    const ordinary = await Effect.runPromise(
      decideOrchestrationCommand({ readModel: model, command: turnStart({}) }),
    );
    expect(Array.isArray(ordinary) ? ordinary.map((event) => event.type) : []).toContain(
      "thread.runtime-mode-set",
    );
  });

  it("start without settings events when the conversation still matches", async () => {
    const decision = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: await readModel(),
        command: turnStart({ requireCurrentSettings: true, runtimeMode: "approval-required" }),
      }),
    );
    const types = (Array.isArray(decision) ? decision : [decision]).map((event) => event.type);
    expect(types).toContain("thread.message-sent");
    expect(types).not.toContain("thread.runtime-mode-set");
    expect(types).not.toContain("thread.interaction-mode-set");
  });
});
