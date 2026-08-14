import { CommandId, EventId, ProjectId, ThreadId } from "@t3tools/contracts";
import { Effect, Exit, Scope, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
import { startThreadSnoozeReactor } from "./threadSnoozeReactor.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-snooze-reactor");
const NOW = "2026-08-15T09:00:00.000Z";

async function makeSnoozedReadModel(snoozedUntil: string) {
  const created = await Effect.runPromise(
    projectEvent(createEmptyReadModel(NOW), {
      sequence: 1,
      eventId: EventId.makeUnsafe("event-snooze-reactor-create"),
      aggregateKind: "thread",
      aggregateId: THREAD_ID,
      type: "thread.created",
      occurredAt: NOW,
      commandId: CommandId.makeUnsafe("command-snooze-reactor-create"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("command-snooze-reactor-create"),
      metadata: {},
      payload: {
        threadId: THREAD_ID,
        projectId: ProjectId.makeUnsafe("project-snooze-reactor"),
        title: "Snoozed thread",
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
  return Effect.runPromise(
    projectEvent(created, {
      sequence: 2,
      eventId: EventId.makeUnsafe("event-snooze-reactor-snoozed"),
      aggregateKind: "thread",
      aggregateId: THREAD_ID,
      type: "thread.snoozed",
      occurredAt: NOW,
      commandId: CommandId.makeUnsafe("command-snooze-reactor-snoozed"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("command-snooze-reactor-snoozed"),
      metadata: {},
      payload: {
        threadId: THREAD_ID,
        snoozedUntil,
        snoozedAt: NOW,
      },
    }),
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("thread snooze reactor", () => {
  it("reconciles an overdue snooze on startup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T10:00:00.000Z"));
    let readModel = await makeSnoozedReadModel("2026-08-15T09:30:00.000Z");
    const dispatched: Array<{ type: string; expectedSnoozedUntil?: string | undefined }> = [];
    const engine: OrchestrationEngineShape = {
      getReadModel: () => Effect.succeed(readModel),
      readEvents: () => Stream.empty,
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          readModel = {
            ...readModel,
            threads: readModel.threads.map((thread) =>
              thread.id === THREAD_ID ? { ...thread, snoozedUntil: null, snoozedAt: null } : thread,
            ),
          };
          return { sequence: 3 };
        }),
      acquireMaintenanceLock: () => Effect.die("unsupported"),
      streamDomainEvents: Stream.empty,
    };
    const scope = await Effect.runPromise(Scope.make("sequential"));

    await Effect.runPromise(startThreadSnoozeReactor(engine).pipe(Scope.provide(scope)));
    await vi.advanceTimersByTimeAsync(1);

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      type: "thread.unsnooze",
      expectedSnoozedUntil: "2026-08-15T09:30:00.000Z",
    });
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("discards a timer after the thread is re-snoozed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T10:00:00.000Z"));
    let readModel = await makeSnoozedReadModel("2026-08-15T10:00:01.000Z");
    const dispatched: string[] = [];
    const engine: OrchestrationEngineShape = {
      getReadModel: () => Effect.succeed(readModel),
      readEvents: () => Stream.empty,
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command.type);
          return { sequence: 3 };
        }),
      acquireMaintenanceLock: () => Effect.die("unsupported"),
      streamDomainEvents: Stream.empty,
    };
    const scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(startThreadSnoozeReactor(engine).pipe(Scope.provide(scope)));

    readModel = {
      ...readModel,
      threads: readModel.threads.map((thread) =>
        thread.id === THREAD_ID ? { ...thread, snoozedUntil: "2026-08-15T11:00:00.000Z" } : thread,
      ),
    };
    await vi.advanceTimersByTimeAsync(1_001);

    expect(dispatched).toEqual([]);
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });
});
