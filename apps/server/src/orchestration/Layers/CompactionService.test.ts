import {
  CommandId,
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { Deferred, Effect, Exit, Layer, ManagedRuntime, PubSub, Scope, Stream } from "effect";

import { ProviderSessionNotFoundError } from "../../provider/Errors.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { CompactionService } from "../Services/CompactionService.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { CompactionServiceLive } from "./CompactionService.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");
const PROJECT_ID = ProjectId.makeUnsafe("project-1");
const NOW = "2026-04-03T12:00:00.000Z";

function makeReadModel(): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: NOW,
    projects: [
      {
        id: PROJECT_ID,
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModel: null,
        scripts: [],
        memories: [],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
    ],
    planningWorkflows: [],
    codeReviewWorkflows: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Thread",
        model: "claude-sonnet-4-6",
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        archivedAt: null,
        createdAt: NOW,
        lastInteractionAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
        messages: [
          {
            id: MessageId.makeUnsafe("message-1"),
            role: "user",
            text: "Compact the conversation",
            streaming: false,
            turnId: null,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
        proposedPlans: [],
        tasks: [],
        tasksTurnId: null,
        tasksUpdatedAt: null,
        activities: [],
        checkpoints: [],
        compaction: null,
        session: {
          threadId: THREAD_ID,
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW,
        },
      },
    ],
  };
}

function makeCompactRequestedEvent(
  eventId: string,
): Extract<OrchestrationEvent, { type: "thread.compact-requested" }> {
  return {
    sequence: 1,
    eventId: EventId.makeUnsafe(eventId),
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.compact-requested",
    occurredAt: NOW,
    commandId: CommandId.makeUnsafe(`cmd-${eventId}`),
    causationEventId: null,
    correlationId: CommandId.makeUnsafe(`cmd-${eventId}`),
    metadata: {},
    payload: {
      threadId: THREAD_ID,
      createdAt: NOW,
      trigger: "manual",
      direction: null,
      pivotMessageId: null,
    },
  };
}

async function createHarness(input?: {
  readonly compactConversation?: ProviderServiceShape["compactConversation"];
  readonly runOneOffPrompt?: ProviderServiceShape["runOneOffPrompt"];
  readonly stopSession?: ProviderServiceShape["stopSession"];
}) {
  const domainEventPubSub = Effect.runSync(PubSub.unbounded<OrchestrationEvent>());
  let readModel = makeReadModel();
  const dispatched: OrchestrationCommand[] = [];

  const orchestrationEngine: OrchestrationEngineShape = {
    getReadModel: () => Effect.succeed(readModel),
    readEvents: () => Stream.empty,
    dispatch: (command) =>
      Effect.sync(() => {
        dispatched.push(command);
        if (command.type === "thread.compacted.record") {
          readModel = {
            ...readModel,
            threads: readModel.threads.map((thread) =>
              thread.id === command.threadId
                ? {
                    ...thread,
                    compaction: command.compaction,
                    lastInteractionAt: command.createdAt,
                    updatedAt: command.createdAt,
                  }
                : thread,
            ),
          };
        }
        if (command.type === "thread.activity.append") {
          readModel = {
            ...readModel,
            threads: readModel.threads.map((thread) =>
              thread.id === command.threadId
                ? {
                    ...thread,
                    activities: [...thread.activities, command.activity],
                    lastInteractionAt: command.createdAt,
                    updatedAt: command.createdAt,
                  }
                : thread,
            ),
          };
        }
        return { sequence: dispatched.length };
      }),
    streamDomainEvents: Stream.fromPubSub(domainEventPubSub),
  };

  const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
  const providerService: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession:
      input?.stopSession ?? (() => Effect.void as ReturnType<ProviderServiceShape["stopSession"]>),
    listSessions: () => Effect.succeed([]),
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "restart-session" }),
    readThread: () => unsupported(),
    rollbackConversation: () => unsupported(),
    runOneOffPrompt:
      input?.runOneOffPrompt ??
      (() =>
        Effect.succeed({
          text: "<summary>Compacted summary</summary>",
        })),
    compactConversation:
      input?.compactConversation ??
      (() =>
        Effect.succeed({
          summary: "<summary>Compacted summary</summary>",
        })),
    reloadMcpConfigForProject: () => unsupported(),
    streamEvents: Stream.empty,
  };

  const runtime = ManagedRuntime.make(
    CompactionServiceLive.pipe(
      Layer.provideMerge(Layer.succeed(OrchestrationEngineService, orchestrationEngine)),
      Layer.provideMerge(Layer.succeed(ProviderService, providerService)),
    ),
  );
  const service = await runtime.runPromise(Effect.service(CompactionService));
  const scope = await Effect.runPromise(Scope.make("sequential"));
  await Effect.runPromise(service.start.pipe(Scope.provide(scope)));
  await Effect.runPromise(Effect.sleep("0 millis"));

  return {
    service,
    dispatched,
    emit: (event: OrchestrationEvent) => Effect.runSync(PubSub.publish(domainEventPubSub, event)),
    mutateReadModel: (mutator: (current: OrchestrationReadModel) => OrchestrationReadModel) => {
      readModel = mutator(readModel);
    },
    dispose: async () => {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await runtime.dispose();
    },
  };
}

describe("CompactionService", () => {
  const disposers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(disposers.splice(0).map((dispose) => dispose()));
  });

  it("does not record compaction success when stopSession fails", async () => {
    const harness = await createHarness({
      stopSession: () =>
        Effect.fail(
          new ProviderSessionNotFoundError({
            threadId: THREAD_ID,
          }),
        ),
    });
    disposers.push(harness.dispose);

    harness.emit(makeCompactRequestedEvent("event-stop-fail"));
    await Effect.runPromise(harness.service.drain);

    expect(harness.dispatched.some((command) => command.type === "thread.compacted.record")).toBe(
      false,
    );
    expect(
      harness.dispatched.some(
        (command) =>
          command.type === "thread.activity.append" &&
          command.activity.kind === "thread.compaction.stop-session-failed",
      ),
    ).toBe(true);
  });

  it("abandons stale compaction results when thread activity changes mid-flight", async () => {
    const started = Effect.runSync(Deferred.make<void>());
    const release = Effect.runSync(Deferred.make<void>());
    let stopSessionCalls = 0;
    const runOneOffPrompt: ProviderServiceShape["runOneOffPrompt"] = () =>
      Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined);
        yield* Deferred.await(release);
        return {
          text: "<summary>Compacted summary</summary>",
        };
      });
    const harness = await createHarness({
      runOneOffPrompt,
      stopSession: () =>
        Effect.sync(() => {
          stopSessionCalls += 1;
        }),
    });
    disposers.push(harness.dispose);

    harness.emit(makeCompactRequestedEvent("event-stale"));
    await Effect.runPromise(Deferred.await(started));

    harness.mutateReadModel((current) => ({
      ...current,
      threads: current.threads.map((thread) =>
        thread.id === THREAD_ID
          ? {
              ...thread,
              lastInteractionAt: "2026-04-03T12:01:00.000Z",
              updatedAt: "2026-04-03T12:01:00.000Z",
              messages: [
                ...thread.messages,
                {
                  id: MessageId.makeUnsafe("message-2"),
                  role: "user",
                  text: "New request arrived",
                  streaming: false,
                  turnId: null,
                  createdAt: "2026-04-03T12:01:00.000Z",
                  updatedAt: "2026-04-03T12:01:00.000Z",
                },
              ],
            }
          : thread,
      ),
    }));

    await Effect.runPromise(Deferred.succeed(release, undefined).pipe(Effect.orDie));
    await Effect.runPromise(harness.service.drain);

    expect(stopSessionCalls).toBe(0);
    expect(harness.dispatched.some((command) => command.type === "thread.compacted.record")).toBe(
      false,
    );
    expect(
      harness.dispatched.some(
        (command) =>
          command.type === "thread.activity.append" &&
          command.activity.kind === "thread.compaction.aborted",
      ),
    ).toBe(true);
  });

  it("ignores duplicate compaction requests while one is already pending", async () => {
    const started = Effect.runSync(Deferred.make<void>());
    const release = Effect.runSync(Deferred.make<void>());
    let compactCalls = 0;
    const runOneOffPrompt: ProviderServiceShape["runOneOffPrompt"] = () =>
      Effect.gen(function* () {
        compactCalls += 1;
        yield* Deferred.succeed(started, undefined);
        yield* Deferred.await(release);
        return {
          text: "<summary>Compacted summary</summary>",
        };
      });
    const harness = await createHarness({
      runOneOffPrompt,
    });
    disposers.push(harness.dispose);

    harness.emit(makeCompactRequestedEvent("event-duplicate-1"));
    await Effect.runPromise(Deferred.await(started));
    harness.emit(makeCompactRequestedEvent("event-duplicate-2"));

    await Effect.runPromise(Deferred.succeed(release, undefined).pipe(Effect.orDie));
    await Effect.runPromise(harness.service.drain);

    expect(compactCalls).toBe(1);
    expect(
      harness.dispatched.filter((command) => command.type === "thread.compacted.record").length,
    ).toBe(1);
  });

  it("runs compaction for non-Claude threads using the thread provider", async () => {
    let requestedProvider: string | null = null;
    let requestedRuntimeMode: string | null = null;
    const harness = await createHarness({
      runOneOffPrompt: (input) =>
        Effect.sync(() => {
          requestedProvider = input.provider;
          requestedRuntimeMode = input.runtimeMode ?? null;
          return {
            text: "<summary>Compacted summary</summary>",
          };
        }),
    });
    disposers.push(harness.dispose);

    harness.mutateReadModel((current) => ({
      ...current,
      threads: current.threads.map((thread) =>
        thread.id === THREAD_ID
          ? {
              ...thread,
              model: "gpt-5.3-codex",
              runtimeMode: "approval-required",
              session: thread.session
                ? {
                    ...thread.session,
                    providerName: "codex",
                  }
                : null,
            }
          : thread,
      ),
    }));

    harness.emit(makeCompactRequestedEvent("event-codex"));
    await Effect.runPromise(harness.service.drain);

    expect(requestedProvider).toBe("codex");
    expect(requestedRuntimeMode).toBe("approval-required");
    expect(harness.dispatched.some((command) => command.type === "thread.compacted.record")).toBe(
      true,
    );
  });

  it("uses a safe Codex one-off model when compacting OpenCode threads", async () => {
    const requests: Array<{ provider: string; model: string | undefined }> = [];
    const harness = await createHarness({
      runOneOffPrompt: (input) =>
        Effect.sync(() => {
          requests.push({ provider: input.provider, model: input.model });
          return {
            text: "<summary>Compacted summary</summary>",
          };
        }),
    });
    disposers.push(harness.dispose);

    harness.mutateReadModel((current) => ({
      ...current,
      threads: current.threads.map((thread) =>
        thread.id === THREAD_ID
          ? {
              ...thread,
              model: "opencode/big-pickle",
              session: thread.session
                ? {
                    ...thread.session,
                    providerName: "opencode",
                  }
                : null,
            }
          : thread,
      ),
    }));

    harness.emit(makeCompactRequestedEvent("event-opencode"));
    await Effect.runPromise(harness.service.drain);

    expect(requests).toEqual([
      {
        provider: "codex",
        model: DEFAULT_GIT_TEXT_GENERATION_MODEL,
      },
    ]);
    expect(harness.dispatched.some((command) => command.type === "thread.compacted.record")).toBe(
      true,
    );
  });
});
