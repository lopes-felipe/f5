import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-08-15T09:00:00.000Z";
const THREAD_ID = ThreadId.makeUnsafe("thread-title-regeneration");

async function makeReadModel(): Promise<OrchestrationReadModel> {
  return Effect.runPromise(
    projectEvent(createEmptyReadModel(NOW), {
      sequence: 1,
      eventId: EventId.makeUnsafe("event-create-title-thread"),
      aggregateKind: "thread",
      aggregateId: THREAD_ID,
      type: "thread.created",
      occurredAt: NOW,
      commandId: CommandId.makeUnsafe("command-create-title-thread"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("command-create-title-thread"),
      metadata: {},
      payload: {
        threadId: THREAD_ID,
        projectId: ProjectId.makeUnsafe("project-title-regeneration"),
        title: "New thread",
        titleSource: "default",
        titleRevision: 0,
        titleUpdatedAt: NOW,
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
}

async function decide(
  readModel: OrchestrationReadModel,
  command: Parameters<typeof decideOrchestrationCommand>[0]["command"],
) {
  return Effect.runPromise(decideOrchestrationCommand({ readModel, command }));
}

async function apply(
  readModel: OrchestrationReadModel,
  event: Omit<OrchestrationEvent, "sequence"> | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
) {
  const first = Array.isArray(event) ? event[0] : event;
  if (!first) return readModel;
  return Effect.runPromise(
    projectEvent(readModel, { ...first, sequence: readModel.snapshotSequence + 1 }),
  );
}

function firstEvent(
  event: Omit<OrchestrationEvent, "sequence"> | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
): Omit<OrchestrationEvent, "sequence"> {
  return (Array.isArray(event) ? event[0] : event) as Omit<OrchestrationEvent, "sequence">;
}

describe("thread title regeneration", () => {
  it("keeps the newer request when an older regeneration completes", async () => {
    const initial = await makeReadModel();
    const firstRequestId = CommandId.makeUnsafe("command-title-regenerate-first");
    const firstStarted = await decide(initial, {
      type: "thread.meta.update",
      commandId: firstRequestId,
      threadId: THREAD_ID,
      regenerateTitle: true,
    });
    const afterFirst = await apply(initial, firstStarted);

    const secondRequestId = CommandId.makeUnsafe("command-title-regenerate-second");
    const secondStarted = await decide(afterFirst, {
      type: "thread.meta.update",
      commandId: secondRequestId,
      threadId: THREAD_ID,
      regenerateTitle: true,
    });
    const afterSecond = await apply(afterFirst, secondStarted);

    const staleCompletion = await decide(afterSecond, {
      type: "thread.title.regeneration.complete",
      commandId: CommandId.makeUnsafe("command-title-complete-stale"),
      threadId: THREAD_ID,
      requestId: firstRequestId,
      expectedTitleRevision: 0,
      title: "Stale generated title",
      createdAt: NOW,
    });
    expect(firstEvent(staleCompletion).type).toBe("thread.title-regeneration-discarded");
    const afterStale = await apply(afterSecond, staleCompletion);
    expect(afterStale.threads[0]?.title).toBe("New thread");
    expect(afterStale.threads[0]?.titleRegeneration?.requestId).toBe(secondRequestId);
  });

  it("does not overwrite a newer manual rename", async () => {
    const initial = await makeReadModel();
    const requestId = CommandId.makeUnsafe("command-title-regenerate-manual-race");
    const started = await decide(initial, {
      type: "thread.meta.update",
      commandId: requestId,
      threadId: THREAD_ID,
      regenerateTitle: true,
    });
    const pending = await apply(initial, started);
    const renamed = await apply(
      pending,
      await decide(pending, {
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("command-title-manual-rename"),
        threadId: THREAD_ID,
        title: "Manual title",
      }),
    );
    const completion = await decide(renamed, {
      type: "thread.title.regeneration.complete",
      commandId: CommandId.makeUnsafe("command-title-complete-after-manual"),
      threadId: THREAD_ID,
      requestId,
      expectedTitleRevision: 0,
      title: "Generated title",
      createdAt: NOW,
    });
    const afterCompletion = await apply(renamed, completion);
    expect(afterCompletion.threads[0]?.title).toBe("Manual title");
    expect(afterCompletion.threads[0]?.titleSource).toBe("manual");
    expect(afterCompletion.threads[0]?.titleRevision).toBe(1);
  });

  it("applies the correlated result and records generated title provenance", async () => {
    const initial = await makeReadModel();
    const requestId = CommandId.makeUnsafe("command-title-regenerate-success");
    const started = await decide(initial, {
      type: "thread.meta.update",
      commandId: requestId,
      threadId: THREAD_ID,
      regenerateTitle: true,
    });
    const pending = await apply(initial, started);
    const completed = await decide(pending, {
      type: "thread.title.regeneration.complete",
      commandId: CommandId.makeUnsafe("command-title-complete-success"),
      threadId: THREAD_ID,
      requestId,
      expectedTitleRevision: 0,
      title: "Current generated title",
      createdAt: NOW,
    });
    const result = await apply(pending, completed);
    expect(result.threads[0]).toMatchObject({
      title: "Current generated title",
      titleSource: "generated",
      titleRevision: 1,
      titleRegeneration: null,
    });
  });
});
