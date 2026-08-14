import { CommandId, type OrchestrationEvent, type ThreadId } from "@t3tools/contracts";
import { Effect, Stream, type Scope } from "effect";

import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";

const MAX_TIMER_DELAY_MS = 2_147_000_000;

function affectsSnoozeSchedule(event: OrchestrationEvent): ThreadId | null {
  switch (event.type) {
    case "thread.snoozed":
    case "thread.unsnoozed":
    case "thread.archived":
    case "thread.deleted":
    case "thread.pins-replaced":
    case "thread.legacy-pins-imported":
      return event.payload.threadId;
    default:
      return null;
  }
}

export function startThreadSnoozeReactor(
  orchestrationEngine: OrchestrationEngineShape,
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const timers = new Map<ThreadId, ReturnType<typeof setTimeout>>();

    const clearTimer = (threadId: ThreadId) => {
      const timer = timers.get(threadId);
      if (timer !== undefined) clearTimeout(timer);
      timers.delete(threadId);
    };

    const schedule = (threadId: ThreadId, snoozedUntil: string | null): void => {
      clearTimer(threadId);
      if (snoozedUntil === null) return;
      const deadline = Date.parse(snoozedUntil);
      if (!Number.isFinite(deadline)) return;
      const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, deadline - Date.now()));
      const timer = setTimeout(() => {
        timers.delete(threadId);
        Effect.runFork(
          orchestrationEngine.getReadModel().pipe(
            Effect.flatMap((readModel) => {
              const thread = readModel.threads.find((entry) => entry.id === threadId);
              if (thread?.snoozedUntil !== snoozedUntil) return Effect.void;
              if (Date.parse(snoozedUntil) > Date.now()) {
                return Effect.sync(() => schedule(threadId, snoozedUntil));
              }
              const createdAt = new Date().toISOString();
              return orchestrationEngine
                .dispatch({
                  type: "thread.unsnooze",
                  commandId: CommandId.makeUnsafe(crypto.randomUUID()),
                  threadId,
                  expectedSnoozedUntil: snoozedUntil,
                  createdAt,
                })
                .pipe(Effect.asVoid);
            }),
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to wake snoozed thread", {
                threadId,
                snoozedUntil,
                cause,
              }),
            ),
          ),
        );
      }, delay);
      timer.unref();
      timers.set(threadId, timer);
    };

    const reconcileThread = (threadId: ThreadId) =>
      orchestrationEngine.getReadModel().pipe(
        Effect.tap((readModel) =>
          Effect.sync(() => {
            const thread = readModel.threads.find((entry) => entry.id === threadId);
            schedule(threadId, thread?.snoozedUntil ?? null);
          }),
        ),
        Effect.asVoid,
      );

    const startup = yield* orchestrationEngine.getReadModel();
    for (const thread of startup.threads) {
      schedule(thread.id, thread.snoozedUntil ?? null);
    }

    yield* Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
      if (event.type === "thread.pins-replaced" || event.type === "thread.legacy-pins-imported") {
        return orchestrationEngine.getReadModel().pipe(
          Effect.tap((readModel) =>
            Effect.sync(() => {
              for (const thread of readModel.threads) {
                schedule(thread.id, thread.snoozedUntil ?? null);
              }
            }),
          ),
          Effect.asVoid,
        );
      }
      const threadId = affectsSnoozeSchedule(event);
      return threadId === null ? Effect.void : reconcileThread(threadId);
    }).pipe(Effect.forkScoped);

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const timer of timers.values()) clearTimeout(timer);
        timers.clear();
      }),
    );
  });
}
