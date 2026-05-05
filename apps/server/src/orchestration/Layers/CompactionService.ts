import { CommandId, EventId, type OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { Cause, Effect, Layer, Stream } from "effect";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { buildThreadCompactionTranscript } from "../compactionService.ts";
import {
  formatCompactSummary,
  getCompactPrompt,
  getPartialCompactPrompt,
} from "../compactionPrompts.ts";
import { resolveOneOffPromptRoute } from "../oneOffPromptRouting.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { CompactionService, type CompactionServiceShape } from "../Services/CompactionService.ts";

type ThreadCompactRequestedEvent = Extract<
  OrchestrationEvent,
  { type: "thread.compact-requested" }
>;

const compactionCommandId = (tag: string) =>
  CommandId.makeUnsafe(`compaction:${tag}:${crypto.randomUUID()}`);

function laterIsoString(left: string, right: string): string {
  return left.localeCompare(right) >= 0 ? left : right;
}

function threadHasChangedSince(
  baselineLastInteractionAt: string,
  currentLastInteractionAt: string,
): boolean {
  return currentLastInteractionAt.localeCompare(baselineLastInteractionAt) > 0;
}

function threadSessionIsBusy(input: {
  readonly status: string;
  readonly activeTurnId: string | null;
}): boolean {
  return input.status === "starting" || input.status === "running" || input.activeTurnId !== null;
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const pendingThreadIds = new Set<ThreadId>();

  const appendActivity = (input: {
    readonly threadId: ThreadId;
    readonly tone: "info" | "error";
    readonly kind: string;
    readonly summary: string;
    readonly payload: Record<string, unknown>;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: compactionCommandId("activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: input.tone,
        kind: input.kind,
        summary: input.summary,
        payload: input.payload,
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const processEvent = (event: ThreadCompactRequestedEvent) =>
    Effect.gen(function* () {
      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.find(
        (entry) => entry.id === event.payload.threadId && entry.deletedAt === null,
      );
      if (!thread) {
        return;
      }
      if (
        thread.compaction &&
        thread.lastInteractionAt.localeCompare(thread.compaction.createdAt) <= 0
      ) {
        return;
      }

      const oneOffRoute = resolveOneOffPromptRoute({
        model: thread.model,
        sessionProviderName: thread.session?.providerName ?? null,
      });
      if (
        thread.session?.status === "running" &&
        thread.session.activeTurnId !== null &&
        thread.session.activeTurnId !== undefined
      ) {
        yield* appendActivity({
          threadId: thread.id,
          tone: "error",
          kind: "thread.compaction.failed",
          summary: "Conversation compaction failed",
          payload: {
            detail: "Interrupt the current turn before compacting the conversation.",
          },
          createdAt: event.occurredAt,
        });
        return;
      }

      const transcript = buildThreadCompactionTranscript({
        thread,
        direction: event.payload.direction,
        pivotMessageId: event.payload.pivotMessageId,
      });
      if (transcript.transcript.trim().length === 0) {
        yield* appendActivity({
          threadId: thread.id,
          tone: "error",
          kind: "thread.compaction.failed",
          summary: "Conversation compaction failed",
          payload: {
            detail: "Not enough conversation history was available to build a compaction summary.",
          },
          createdAt: event.occurredAt,
        });
        return;
      }

      const promptBody =
        event.payload.direction === null
          ? getCompactPrompt()
          : getPartialCompactPrompt(event.payload.direction);
      const prompt = `${promptBody}\n\n## Conversation Context\n${transcript.transcript}`;
      const cwd = resolveThreadWorkspaceCwd({
        thread,
        projects: readModel.projects,
      });
      const completedAt = new Date().toISOString();
      const baselineLastInteractionAt = laterIsoString(thread.lastInteractionAt, event.occurredAt);

      const summaryResult = yield* providerService
        .runOneOffPrompt({
          threadId: thread.id,
          provider: oneOffRoute.provider,
          prompt,
          ...(cwd ? { cwd } : {}),
          model: oneOffRoute.model,
          runtimeMode: thread.runtimeMode,
        })
        .pipe(
          Effect.match({
            onFailure: (error) => ({ ok: false as const, error }),
            onSuccess: (result) => ({ ok: true as const, result }),
          }),
        );

      if (!summaryResult.ok) {
        yield* appendActivity({
          threadId: thread.id,
          tone: "error",
          kind: "thread.compaction.failed",
          summary: "Conversation compaction failed",
          payload: {
            detail: summaryResult.error.message,
          },
          createdAt: completedAt,
        });
        return;
      }

      const formattedSummary = formatCompactSummary(summaryResult.result.text);
      if (formattedSummary.length === 0) {
        yield* appendActivity({
          threadId: thread.id,
          tone: "error",
          kind: "thread.compaction.failed",
          summary: "Conversation compaction failed",
          payload: {
            detail: "The provider returned an empty compaction summary.",
          },
          createdAt: completedAt,
        });
        return;
      }

      const latestReadModel = yield* orchestrationEngine.getReadModel();
      const latestThread = latestReadModel.threads.find(
        (entry) => entry.id === event.payload.threadId && entry.deletedAt === null,
      );
      if (!latestThread) {
        return;
      }
      if (
        threadHasChangedSince(baselineLastInteractionAt, latestThread.lastInteractionAt) ||
        (latestThread.session &&
          threadSessionIsBusy({
            status: latestThread.session.status,
            activeTurnId: latestThread.session.activeTurnId,
          }))
      ) {
        yield* appendActivity({
          threadId: latestThread.id,
          tone: "error",
          kind: "thread.compaction.aborted",
          summary: "Conversation compaction aborted",
          payload: {
            detail:
              "The thread changed while compaction was running. Start compaction again from the latest conversation state.",
          },
          createdAt: completedAt,
        });
        return;
      }

      if (latestThread.session && latestThread.session.status !== "stopped") {
        const stopSessionResult = yield* providerService
          .stopSession({ threadId: latestThread.id })
          .pipe(
            Effect.match({
              onFailure: (error) => error,
              onSuccess: () => null,
            }),
          );
        if (stopSessionResult !== null) {
          yield* appendActivity({
            threadId: latestThread.id,
            tone: "error",
            kind: "thread.compaction.stop-session-failed",
            summary: "Conversation compaction failed",
            payload: {
              detail: stopSessionResult.message,
            },
            createdAt: completedAt,
          });
          return;
        }
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.compacted.record",
        commandId: compactionCommandId("record"),
        threadId: latestThread.id,
        compaction: {
          summary: formattedSummary,
          trigger: event.payload.trigger,
          estimatedTokens: transcript.estimatedTokens,
          modelContextWindowTokens: transcript.modelContextWindowTokens,
          createdAt: completedAt,
          direction: event.payload.direction,
          pivotMessageId: event.payload.pivotMessageId,
          fromTurnCount: transcript.fromTurnCount,
          toTurnCount: transcript.toTurnCount,
        },
        createdAt: completedAt,
      });

      yield* appendActivity({
        threadId: latestThread.id,
        tone: "info",
        kind: "thread.compaction.completed",
        summary: "Conversation compacted",
        payload: {
          trigger: event.payload.trigger,
          estimatedTokens: transcript.estimatedTokens,
          modelContextWindowTokens: transcript.modelContextWindowTokens,
        },
        createdAt: completedAt,
      });
    });

  const worker = yield* makeDrainableWorker((event: ThreadCompactRequestedEvent) =>
    processEvent(event).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          pendingThreadIds.delete(event.payload.threadId);
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("conversation compaction failed", {
          eventId: event.eventId,
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    ),
  );

  const start: CompactionServiceShape["start"] = Effect.forkScoped(
    Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
      if (event.type !== "thread.compact-requested") {
        return Effect.void;
      }
      if (pendingThreadIds.has(event.payload.threadId)) {
        return Effect.logDebug("skipping duplicate thread.compact-requested event", {
          threadId: event.payload.threadId,
          eventId: event.eventId,
        });
      }
      pendingThreadIds.add(event.payload.threadId);
      return worker.enqueue(event);
    }),
  ).pipe(Effect.asVoid);

  return {
    start,
    drain: worker.drain,
  } satisfies CompactionServiceShape;
});

export const CompactionServiceLive = Layer.effect(CompactionService, make);
