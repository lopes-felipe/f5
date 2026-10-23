import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-08-15T09:00:00.000Z";
const THREAD = ThreadId.makeUnsafe("thread-settle");

async function readModelWith(
  overrides: Partial<OrchestrationThread>,
): Promise<OrchestrationReadModel> {
  const readModel = await Effect.runPromise(
    projectEvent(createEmptyReadModel(NOW), {
      sequence: 1,
      eventId: EventId.makeUnsafe("event-create-settle"),
      aggregateKind: "thread",
      aggregateId: THREAD,
      type: "thread.created",
      occurredAt: NOW,
      commandId: CommandId.makeUnsafe("command-create-settle"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("command-create-settle"),
      metadata: {},
      payload: {
        threadId: THREAD,
        projectId: ProjectId.makeUnsafe("project-settle"),
        title: "Settle me",
        model: "gpt-5-codex",
        interactionMode: "default",
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    }),
  );
  return {
    ...readModel,
    threads: readModel.threads.map((thread) => ({ ...thread, ...overrides })),
  };
}

async function settleReason(overrides: Partial<OrchestrationThread>) {
  const error = await Effect.runPromise(
    decideOrchestrationCommand({
      readModel: await readModelWith(overrides),
      command: {
        type: "thread.settle",
        commandId: CommandId.makeUnsafe("command-settle"),
        threadId: THREAD,
        createdAt: NOW,
      },
    }).pipe(Effect.flip),
  );
  return error.message;
}

describe("thread.settle", () => {
  it("says which blocker to clear before a thread can be settled", async () => {
    expect(await settleReason({ pinnedAt: NOW })).toContain(
      "This thread is pinned. Unpin it before settling.",
    );
    expect(await settleReason({ snoozedUntil: "2026-08-16T09:00:00.000Z" })).toContain(
      "This thread is snoozed. Wake it before settling.",
    );
    // A request outranks the run it holds up, since answering it is the next step.
    expect(
      await settleReason({
        pinnedAt: NOW,
        pendingUserInputs: [{ requestId: "input" } as never],
      }),
    ).toContain("This thread is waiting on a question. Answer it before settling.");
  });

  it("settles an idle thread", async () => {
    const event = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: await readModelWith({}),
        command: {
          type: "thread.settle",
          commandId: CommandId.makeUnsafe("command-settle"),
          threadId: THREAD,
          createdAt: NOW,
        },
      }),
    );
    const events = Array.isArray(event) ? event : [event];
    expect(events.map((entry: { type: string }) => entry.type)).toEqual(["thread.settled"]);
  });
});
