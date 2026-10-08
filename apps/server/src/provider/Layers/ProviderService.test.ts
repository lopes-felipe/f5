import { withProviderThreadAccess } from "../providerThreadAccess.ts";
import { Deferred } from "effect";
import { ServerSettingsService } from "../../serverSettings";
import { beginAccountChange } from "../../profiles/ProviderAccountGuard.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  ChatAttachment,
  ProviderApprovalDecision,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderTurnStartResult,
} from "@t3tools/contracts";
import {
  ApprovalRequestId,
  EventId,
  ProjectId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type ProviderKind,
  ProviderSessionStartInput,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { it, assert, vi } from "@effect/vitest";

import { Effect, Fiber, Layer, Metric, Option, PubSub, Ref, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type {
  ProviderAdapterShape,
  ProviderOneOffPromptInput,
  ProviderRollbackOptions,
} from "../Services/ProviderAdapter.ts";
import type { ProviderAdapterSendTurnInput } from "../Services/ProviderAdapter.ts";
import {
  ProviderAdapterRegistry,
  type ProviderAdapterRegistryShape,
} from "../Services/ProviderAdapterRegistry.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { makeProviderServiceLive, type ProviderServiceLiveOptions } from "./ProviderService.ts";
import {
  makeAdapterRegistryMock,
  type KindAdapterMap,
} from "../testUtils/providerAdapterRegistryMock.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectMcpConfigService } from "../../mcp/ProjectMcpConfigService.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import { AnalyticsService } from "../../telemetry/Services/AnalyticsService.ts";
import { ServerConfig } from "../../config.ts";

const providerServiceConfigLayer = ServerConfig.layerTest(
  process.cwd(),
  path.join(os.tmpdir(), `f5-provider-service-tests-${process.pid}`),
).pipe(Layer.provide(NodeServices.layer));

const asRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

function makeProjectMcpConfigServiceTestLayer() {
  return Layer.succeed(ProjectMcpConfigService, {
    readCommonStoredConfig: () =>
      Effect.succeed({
        scope: "common" as const,
        version: "mcp-version-test",
        servers: {},
      }),
    readProjectStoredConfig: (projectId) =>
      Effect.succeed({
        scope: "project" as const,
        projectId,
        version: "mcp-version-test",
        servers: {},
      }),
    readEffectiveStoredConfig: (projectId) =>
      Effect.succeed({
        projectId,
        commonVersion: "mcp-version-test",
        projectVersion: "mcp-version-test",
        effectiveVersion: "mcp-version-test",
        servers: {},
      }),
    readCommonConfig: () =>
      Effect.succeed({
        version: "mcp-version-test",
        servers: {},
      }),
    replaceCommonConfig: (_input) =>
      Effect.succeed({
        version: "mcp-version-test",
        servers: {},
      }),
    readProjectConfig: (projectId) =>
      Effect.succeed({
        projectId,
        version: "mcp-version-test",
        servers: {},
      }),
    replaceProjectConfig: (input) =>
      Effect.succeed({
        projectId: input.projectId,
        version: "mcp-version-test",
        servers: {},
      }),
    readEffectiveConfig: (projectId) =>
      Effect.succeed({
        projectId,
        commonVersion: "mcp-version-test",
        projectVersion: "mcp-version-test",
        effectiveVersion: "mcp-version-test",
        servers: {},
      }),
    readCodexServers: (projectId) =>
      Effect.succeed({
        projectId,
        effectiveVersion: "mcp-version-test",
        servers: {},
      }),
  });
}

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: "codex";
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

function makeFakeCodexAdapter(provider: ProviderKind = "codex") {
  const sessions = new Map<ThreadId, ProviderSession>();
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());

  const startSession = vi.fn((input: ProviderSessionStartInput) =>
    Effect.sync(() => {
      const now = new Date().toISOString();
      const session: ProviderSession = {
        provider,
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        resumeCursor: input.resumeCursor ?? { opaque: `cursor-${String(input.threadId)}` },
        cwd: input.cwd ?? process.cwd(),
        createdAt: now,
        updatedAt: now,
      };
      sessions.set(session.threadId, session);
      return session;
    }),
  );

  const sendTurn = vi.fn(
    (
      input: ProviderAdapterSendTurnInput,
    ): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> => {
      if (!sessions.has(input.threadId)) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider,
            threadId: input.threadId,
          }),
        );
      }

      return Effect.succeed({
        threadId: input.threadId,
        turnId: TurnId.makeUnsafe(`turn-${String(input.threadId)}`),
      });
    },
  );

  const interruptTurn = vi.fn(
    (_threadId: ThreadId, _turnId?: TurnId): Effect.Effect<void, ProviderAdapterError> =>
      Effect.void,
  );

  const respondToRequest = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _decision: ProviderApprovalDecision,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );

  const respondToUserInput = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _answers: Record<string, unknown>,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );

  const stopSession = vi.fn(
    (threadId: ThreadId): Effect.Effect<void, ProviderAdapterError> =>
      Effect.sync(() => {
        sessions.delete(threadId);
      }),
  );

  const listSessions = vi.fn(
    (): Effect.Effect<ReadonlyArray<ProviderSession>> =>
      Effect.sync(() => Array.from(sessions.values())),
  );

  const hasSession = vi.fn(
    (threadId: ThreadId): Effect.Effect<boolean> => Effect.succeed(sessions.has(threadId)),
  );

  const readThread = vi.fn(
    (
      threadId: ThreadId,
    ): Effect.Effect<
      {
        threadId: ThreadId;
        turns: ReadonlyArray<{ id: TurnId; items: readonly [] }>;
      },
      ProviderAdapterError
    > =>
      Effect.succeed({
        threadId,
        turns: [{ id: asTurnId("turn-1"), items: [] }],
      }),
  );

  const rollbackThread = vi.fn(
    (
      threadId: ThreadId,
      _numTurns: number,
    ): Effect.Effect<{ threadId: ThreadId; turns: readonly [] }, ProviderAdapterError> =>
      Effect.succeed({ threadId, turns: [] }),
  );

  const reloadMcpConfig = vi.fn(
    (threadId: ThreadId): Effect.Effect<void, ProviderAdapterError> =>
      sessions.has(threadId)
        ? Effect.void
        : Effect.fail(
            new ProviderAdapterSessionNotFoundError({
              provider,
              threadId,
            }),
          ),
  );

  const stopAll = vi.fn(
    (): Effect.Effect<void, ProviderAdapterError> =>
      Effect.sync(() => {
        sessions.clear();
      }),
  );

  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider,
    capabilities: {
      sessionModelSwitch: "in-session",
    },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    reloadMcpConfig,
    stopAll,
    streamEvents: Stream.fromPubSub(runtimeEventPubSub),
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event as unknown as ProviderRuntimeEvent));
  };

  return {
    adapter,
    emit,
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    reloadMcpConfig,
    stopAll,
  };
}

const sleep = (ms: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

function counterValue(
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
): number {
  const snapshot = snapshots.find(
    (entry) =>
      entry.id === id &&
      entry.type === "Counter" &&
      Object.entries(attributes).every(([key, value]) => entry.attributes?.[key] === value),
  );
  return snapshot?.type === "Counter" ? Number(snapshot.state.count) : 0;
}

function histogramCount(
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
): number {
  const snapshot = snapshots.find(
    (entry) =>
      entry.id === id &&
      entry.type === "Histogram" &&
      Object.entries(attributes).every(([key, value]) => entry.attributes?.[key] === value),
  );
  return snapshot?.type === "Histogram" ? snapshot.state.count : 0;
}

function makeProviderServiceLayer(options?: ProviderServiceLiveOptions) {
  const codex = makeFakeCodexAdapter();
  const registry = makeAdapterRegistryMock({ codex: codex.adapter });

  const providerAdapterLayer = Layer.succeed(ProviderAdapterRegistry, registry);
  const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

  const layer = it.layer(
    Layer.mergeAll(
      makeProviderServiceLive(options).pipe(
        Layer.provide(providerServiceConfigLayer),
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(makeProjectMcpConfigServiceTestLayer()),
        Layer.provideMerge(AnalyticsService.layerTest),
      ),
      directoryLayer,

      runtimeRepositoryLayer,
      NodeServices.layer,
    ),
  );

  return {
    codex,
    layer,
  };
}

function makeProviderServiceLayerForAdapters(
  adaptersByProvider: ReadonlyMap<ProviderKind, ProviderAdapterShape<ProviderAdapterError>>,
  overrides: Partial<ProviderAdapterRegistryShape> = {},
) {
  const registry = {
    ...makeAdapterRegistryMock(Object.fromEntries(adaptersByProvider) as KindAdapterMap),
    ...overrides,
  };

  const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

  return Layer.mergeAll(
    makeProviderServiceLive().pipe(
      Layer.provide(providerServiceConfigLayer),
      Layer.provide(Layer.succeed(ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(makeProjectMcpConfigServiceTestLayer()),
      Layer.provideMerge(AnalyticsService.layerTest),
    ),
    directoryLayer,
    runtimeRepositoryLayer,
    NodeServices.layer,
  );
}

it.effect("ignores a delayed Claude exit cursor from before transcript repair", () => {
  const claude = makeFakeCodexAdapter("claudeAgent");
  const layer = makeProviderServiceLayerForAdapters(new Map([["claudeAgent", claude.adapter]]));
  return Effect.gen(function* () {
    const provider = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const threadId = asThreadId("thread-delayed-claude-exit");
    const oldCursor = { resume: "session", resumeSessionAt: "missing" };
    const repairedCursor = {
      resume: "session",
      resumeSessionAt: "restored",
      resumeRecoveryGeneration: "repair-generation",
    };
    yield* provider.startSession(threadId, {
      threadId,
      provider: "claudeAgent",
      runtimeMode: "full-access",
      resumeCursor: oldCursor,
    });
    yield* directory.upsert({ threadId, provider: "claudeAgent", resumeCursor: repairedCursor });
    const observed = yield* Stream.runHead(
      Stream.filter(provider.streamEvents, (event) => event.type === "session.exited"),
    ).pipe(Effect.forkChild);
    yield* sleep(20);
    claude.emit({
      type: "session.exited",
      eventId: asEventId("delayed-exit"),
      provider: "claudeAgent",
      threadId,
      createdAt: new Date().toISOString(),
      resumeCursor: oldCursor,
      payload: { reason: "process-exit" },
    } as unknown as LegacyProviderRuntimeEvent);
    yield* Fiber.join(observed);
    const binding = yield* directory.getBinding(threadId);
    assert.deepEqual(Option.getOrThrow(binding).resumeCursor, repairedCursor);
  }).pipe(Effect.provide(layer));
});

it.effect("keeps healthy event lanes flowing while another thread cursor is locked", () => {
  const claude = makeFakeCodexAdapter("claudeAgent");
  const layer = makeProviderServiceLayerForAdapters(new Map([["claudeAgent", claude.adapter]]));
  return Effect.gen(function* () {
    const provider = yield* ProviderService;
    const blocked = asThreadId("blocked-cursor-lane"),
      healthy = asThreadId("healthy-cursor-lane");
    for (const threadId of [blocked, healthy])
      yield* provider.startSession(threadId, {
        threadId,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
    const acquired = yield* Deferred.make<void>(),
      release = yield* Deferred.make<void>();
    const lock = yield* withProviderThreadAccess(
      blocked,
      Effect.gen(function* () {
        yield* Deferred.succeed(acquired, undefined);
        yield* Deferred.await(release);
      }),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(acquired);
    const observed: string[] = [];
    yield* Stream.runForEach(provider.streamEvents, (event) =>
      Effect.sync(() => {
        observed.push(event.eventId);
      }),
    ).pipe(Effect.forkChild);
    yield* sleep(20);
    const emit = (threadId: ThreadId, id: string, resumeCursor?: unknown) =>
      claude.emit({
        type: "session.exited",
        eventId: asEventId(id),
        provider: "claudeAgent",
        threadId,
        createdAt: new Date().toISOString(),
        ...(resumeCursor === undefined ? {} : { resumeCursor }),
        payload: { reason: "process-exit" },
      } as unknown as LegacyProviderRuntimeEvent);
    emit(blocked, "no-cursor");
    yield* Effect.promise(() => vi.waitFor(() => assert.include(observed, "no-cursor")));
    emit(blocked, "locked-cursor", { resume: "blocked" });
    emit(healthy, "healthy-first", { resume: "first" });
    emit(healthy, "healthy-second", { resume: "second" });
    yield* Effect.promise(() => vi.waitFor(() => assert.include(observed, "healthy-second")));
    assert.deepEqual(observed, ["no-cursor", "healthy-first", "healthy-second"]);
    const directory = yield* ProviderSessionDirectory;
    assert.deepEqual(Option.getOrThrow(yield* directory.getBinding(healthy)).resumeCursor, {
      resume: "second",
    });
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(lock);
    yield* Effect.promise(() => vi.waitFor(() => assert.include(observed, "locked-cursor")));
  }).pipe(Effect.provide(layer));
});

it.effect("persists invalidation from the current Claude recovery generation", () => {
  const claude = makeFakeCodexAdapter("claudeAgent");
  const layer = makeProviderServiceLayerForAdapters(new Map([["claudeAgent", claude.adapter]]));
  return Effect.gen(function* () {
    const provider = yield* ProviderService,
      directory = yield* ProviderSessionDirectory;
    const threadId = asThreadId("invalidate-repaired-cursor"),
      generation = "repair-generation";
    yield* provider.startSession(threadId, {
      threadId,
      provider: "claudeAgent",
      runtimeMode: "full-access",
      resumeCursor: { resume: "missing", resumeRecoveryGeneration: generation },
    });
    const observed = yield* Stream.runHead(
      Stream.filter(provider.streamEvents, (event) => event.eventId === "current-invalidation"),
    ).pipe(Effect.forkChild);
    yield* sleep(20);
    claude.emit({
      type: "session.exited",
      eventId: asEventId("current-invalidation"),
      provider: "claudeAgent",
      threadId,
      createdAt: new Date().toISOString(),
      resumeCursor: { resumeRecoveryGeneration: generation },
      payload: { reason: "process-exit" },
    } as unknown as LegacyProviderRuntimeEvent);
    yield* Fiber.join(observed);
    assert.deepEqual(Option.getOrThrow(yield* directory.getBinding(threadId)).resumeCursor, {
      resumeRecoveryGeneration: generation,
    });
  }).pipe(Effect.provide(layer));
});

for (const driver of ["grok", "antigravity"] as const)
  it.effect(
    `rejects a custom-named ${driver} instance before opening a read-only workflow session`,
    () => {
      const codex = makeFakeCodexAdapter();
      const registry = makeAdapterRegistryMock({ codex: codex.adapter });
      return Effect.gen(function* () {
        const service = yield* ProviderService;
        const failure = yield* service
          .startSession(asThreadId("document"), {
            threadId: asThreadId("document"),
            providerInstanceId: ProviderInstanceId.make("research-account"),
            runtimeMode: "full-access",
            workflowExecutionProfile: "attended-readonly",
          })
          .pipe(Effect.flip);
        assert.equal(failure._tag, "ProviderValidationError");
        assert.match(failure.message, /cannot enforce read-only/);
      }).pipe(
        Effect.provide(
          makeProviderServiceLayerForAdapters(new Map([["codex", codex.adapter]]), {
            getInstanceInfo: (instanceId) =>
              registry.getInstanceInfo(ProviderInstanceId.make("codex")).pipe(
                Effect.map((info) => ({
                  ...info,
                  instanceId,
                  driverKind: driver as typeof info.driverKind,
                })),
              ),
          }),
        ),
      );
    },
  );

it.effect("persists Codex fork adoption before a failed final read", () => {
  const codex = makeFakeCodexAdapter();
  const adapter = {
    ...codex.adapter,
    rollbackThread: (_threadId: ThreadId, _numTurns: number, options?: ProviderRollbackOptions) =>
      Effect.gen(function* () {
        const old = (yield* codex.listSessions())[0]!;
        yield* Effect.promise(() =>
          options!.onAdoptSession!({
            ...old,
            status: "ready",
            resumeCursor: { threadId: "validated-fork", rewindSourceThreadId: "native-source" },
          }),
        );
        return yield* new ProviderAdapterRequestError({
          provider: "codex",
          method: "thread/read",
          detail: "final read failed",
        });
      }),
  };
  return Effect.gen(function* () {
    const provider = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const threadId = asThreadId("fork-persist-before-read");
    yield* provider.startSession(threadId, {
      threadId,
      provider: "codex",
      runtimeMode: "full-access",
    });
    const result = yield* Effect.exit(provider.rollbackConversation({ threadId, numTurns: 1 }));
    assert.equal(result._tag, "Failure");
    const binding = yield* directory.getBinding(threadId);
    assert.equal(Option.isSome(binding), true);
    assert.deepEqual(Option.isSome(binding) ? binding.value.resumeCursor : undefined, {
      threadId: "validated-fork",
      rewindSourceThreadId: "native-source",
    });
  }).pipe(Effect.provide(makeProviderServiceLayerForAdapters(new Map([["codex", adapter]]))));
});
const routing = makeProviderServiceLayer();
it.effect("advances the session generation and refuses steering from a stale browser", () => {
  const codex = makeFakeCodexAdapter();
  const steerTurn = vi.fn((input: ProviderAdapterSendTurnInput) =>
    Effect.succeed({ threadId: input.threadId, turnId: TurnId.makeUnsafe("turn-steered") }),
  );
  return Effect.gen(function* () {
    const service = yield* ProviderService;
    const threadId = asThreadId("session-generation");
    const start = {
      provider: "codex" as const,
      threadId,
      cwd: process.cwd(),
      runtimeMode: "full-access" as const,
    };
    const first = yield* service.startSession(threadId, start);
    assert.equal(first.capabilities?.generation, 1);
    const second = yield* service.startSession(threadId, start);
    assert.equal(second.capabilities?.generation, 2);
    assert.equal((yield* service.getSessionCapabilities(threadId))?.generation, 2);

    const stale = yield* service
      .sendTurn({
        threadId,
        input: "steer",
        expectedTurnId: TurnId.makeUnsafe("turn-active"),
        expectedSessionGeneration: 1,
      })
      .pipe(Effect.flip);
    assert.equal(stale._tag, "ProviderSessionActionUnavailableError");
    if (stale._tag === "ProviderSessionActionUnavailableError")
      assert.equal(stale.reason.code, "stale-generation");
    assert.equal(steerTurn.mock.calls.length, 0);

    yield* service.sendTurn({
      threadId,
      input: "steer",
      expectedTurnId: TurnId.makeUnsafe("turn-active"),
      expectedSessionGeneration: 2,
    });
    assert.equal(steerTurn.mock.calls.length, 1);
  }).pipe(
    Effect.provide(
      makeProviderServiceLayerForAdapters(new Map([["codex", { ...codex.adapter, steerTurn }]])),
    ),
  );
});
it.effect("does not fall back to compaction for explicitly selected unsupported adapters", () => {
  const codex = makeFakeCodexAdapter();
  const compactConversation = vi.fn(() => Effect.succeed({ summary: "unexpected" }));
  return Effect.gen(function* () {
    const service = yield* ProviderService;
    const failure = yield* service
      .runOneOffPrompt({
        threadId: asThreadId("summary"),
        provider: "codex",
        prompt: "Summarize",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-luna" },
      })
      .pipe(Effect.flip);
    assert.equal(failure._tag, "ProviderValidationError");
    assert.equal(compactConversation.mock.calls.length, 0);
  }).pipe(
    Effect.provide(
      makeProviderServiceLayerForAdapters(
        new Map([["codex", { ...codex.adapter, compactConversation }]]),
      ),
    ),
  );
});
it.effect("rejects disabled explicit summary instances", () => {
  const codex = makeFakeCodexAdapter();
  const registry = makeAdapterRegistryMock({ codex: codex.adapter });
  return Effect.gen(function* () {
    const service = yield* ProviderService;
    const failure = yield* service
      .runOneOffPrompt({
        threadId: asThreadId("summary"),
        provider: "codex",
        prompt: "Summarize",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-luna" },
      })
      .pipe(Effect.flip);
    assert.equal(failure._tag, "ProviderValidationError");
    assert.match(failure.message, /disabled or unsupported/);
  }).pipe(
    Effect.provide(
      makeProviderServiceLayerForAdapters(new Map([["codex", codex.adapter]]), {
        getInstanceInfo: (instanceId) =>
          registry
            .getInstanceInfo(instanceId)
            .pipe(Effect.map((info) => ({ ...info, enabled: false }))),
      }),
    ),
  );
});
for (const driver of ["codex", "claudeAgent"] as const) {
  it.effect(
    `routes explicit ${driver} one-off selections by instance without source account options`,
    () => {
      const source = makeFakeCodexAdapter("claudeAgent");
      const selected = makeFakeCodexAdapter(driver);
      const requests: Array<ProviderOneOffPromptInput> = [];
      const selectedAdapter = {
        ...selected.adapter,
        runOneOffPrompt: (input: ProviderOneOffPromptInput) =>
          Effect.sync(() => {
            requests.push(input);
            return { text: "notes" };
          }),
      };
      return Effect.gen(function* () {
        const service = yield* ProviderService;
        const directory = yield* ProviderSessionDirectory;
        const threadId = asThreadId("summary-source");
        yield* directory.upsert({
          threadId,
          provider: "claudeAgent",
          runtimeMode: "full-access",
          runtimePayload: {
            providerOptions: {
              claudeAgent: { binaryPath: "/source/claude" },
              codex: { homePath: "/wrong-account" },
            },
          },
        });
        const modelSelection = {
          instanceId: ProviderInstanceId.make(`${driver}-work`),
          model: driver === "codex" ? "gpt-5.6-luna" : "claude-sonnet-4-6",
          options: [{ id: driver === "codex" ? "reasoningEffort" : "effort", value: "low" }],
        };
        const result = yield* service.runOneOffPrompt({
          threadId,
          ...(driver === "codex" ? { provider: "claudeAgent" as const } : {}),
          model: "gpt-6-astra",
          prompt: "Summarize",
          modelSelection,
        });
        assert.deepStrictEqual(result, { text: "notes" });
        assert.deepStrictEqual(requests, [
          {
            threadId,
            provider: driver,
            prompt: "Summarize",
            model: driver === "codex" ? "gpt-5.6-luna" : "claude-sonnet-4-6",
            modelSelection,
          },
        ]);
        const failure = yield* service
          .runOneOffPrompt({
            threadId,
            provider: driver,
            prompt: "Summarize",
            modelSelection: { ...modelSelection, instanceId: ProviderInstanceId.make("missing") },
          })
          .pipe(Effect.flip);
        assert.equal(failure._tag, "ProviderUnsupportedError");
        assert.equal(requests.length, 1);
        const missingRoute = yield* service
          .runOneOffPrompt({ threadId, prompt: "Summarize" })
          .pipe(Effect.flip);
        assert.equal(missingRoute._tag, "ProviderValidationError");
      }).pipe(
        Effect.provide(
          makeProviderServiceLayerForAdapters(
            new Map([
              ["claudeAgent", source.adapter],
              [`${driver}-work` as ProviderKind, selectedAdapter],
            ]),
          ),
        ),
      );
    },
  );
}

it.effect("keeps legacy one-off provider options from the source binding", () => {
  const selected = makeFakeCodexAdapter();
  const requests: Array<ProviderOneOffPromptInput> = [];
  const adapter = {
    ...selected.adapter,
    runOneOffPrompt: (input: ProviderOneOffPromptInput) =>
      Effect.sync(() => {
        requests.push(input);
        return { text: "notes" };
      }),
  };
  return Effect.gen(function* () {
    const service = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const threadId = asThreadId("legacy-summary");
    const providerOptions = { codex: { homePath: "/source-account" } };
    yield* directory.upsert({ threadId, provider: "codex", runtimePayload: { providerOptions } });
    yield* service.runOneOffPrompt({ threadId, provider: "codex", prompt: "Summarize" });
    assert.deepStrictEqual(requests[0]?.providerOptions, providerOptions);
  }).pipe(Effect.provide(makeProviderServiceLayerForAdapters(new Map([["codex", adapter]]))));
});
it.effect("ProviderServiceLive keeps persisted resumable sessions on startup", () =>
  Effect.gen(function* () {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-service-"));
    const dbPath = path.join(tempDir, "orchestration.sqlite");

    const codex = makeFakeCodexAdapter();
    const registry = makeAdapterRegistryMock({ codex: codex.adapter });

    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
      Layer.provide(persistenceLayer),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

    yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      yield* directory.upsert({
        provider: "codex",
        threadId: ThreadId.makeUnsafe("thread-stale"),
      });
    }).pipe(Effect.provide(directoryLayer));

    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(providerServiceConfigLayer),
      Layer.provide(Layer.succeed(ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(makeProjectMcpConfigServiceTestLayer()),
      Layer.provide(AnalyticsService.layerTest),
    );

    yield* Effect.gen(function* () {
      yield* ProviderService;
    }).pipe(Effect.provide(providerLayer));

    const persistedProvider = yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      return yield* directory.getProvider(asThreadId("thread-stale"));
    }).pipe(Effect.provide(directoryLayer));
    assert.equal(persistedProvider, "codex");

    const runtime = yield* Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntimeRepository;
      return yield* repository.getByThreadId({ threadId: asThreadId("thread-stale") });
    }).pipe(Effect.provide(runtimeRepositoryLayer));
    assert.equal(Option.isSome(runtime), true);

    const legacyTableRows = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'provider_sessions'
      `;
    }).pipe(Effect.provide(persistenceLayer));
    assert.equal(legacyTableRows.length, 0);

    fs.rmSync(tempDir, { recursive: true, force: true });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderServiceLive restores rollback routing after restart using persisted thread mapping",
  () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-service-restart-"));
      const dbPath = path.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
        Layer.provide(persistenceLayer),
      );

      const firstCodex = makeFakeCodexAdapter();
      const firstRegistry = makeAdapterRegistryMock({ codex: firstCodex.adapter });

      const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const firstProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(providerServiceConfigLayer),
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, firstRegistry)),
        Layer.provide(firstDirectoryLayer),
        Layer.provide(makeProjectMcpConfigServiceTestLayer()),
        Layer.provide(AnalyticsService.layerTest),
      );

      const started = yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        const threadId = asThreadId("thread-1");
        const session = yield* provider.startSession(threadId, {
          provider: "codex",
          cwd: process.cwd(),
          runtimeMode: "full-access",
          threadId,
        });
        const turn = yield* provider.sendTurn({
          threadId,
          input: "work across restart",
          attachments: [],
        });
        return { session, turn };
      }).pipe(Effect.provide(firstProviderLayer));

      const persistedAfterStopAll = yield* Effect.gen(function* () {
        const repository = yield* ProviderSessionRuntimeRepository;
        return yield* repository.getByThreadId({ threadId: started.session.threadId });
      }).pipe(Effect.provide(runtimeRepositoryLayer));
      assert.equal(Option.isSome(persistedAfterStopAll), true);
      if (Option.isSome(persistedAfterStopAll)) {
        assert.equal(persistedAfterStopAll.value.status, "stopped");
        assert.deepEqual(persistedAfterStopAll.value.resumeCursor, started.session.resumeCursor);
        const payload = persistedAfterStopAll.value.runtimePayload;
        assert.equal(payload !== null && typeof payload === "object", true);
        if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
          const payloadRecord = payload as Record<string, unknown>;
          assert.equal(payloadRecord.activeTurnId, started.turn.turnId);
          assert.equal(payloadRecord.lastRuntimeEvent, "provider.stopAll");
          assert.equal(typeof payloadRecord.lastRuntimeEventAt, "string");
        }
      }

      const secondCodex = makeFakeCodexAdapter();
      const secondRegistry = makeAdapterRegistryMock({ codex: secondCodex.adapter });
      const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const secondProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(providerServiceConfigLayer),
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, secondRegistry)),
        Layer.provide(secondDirectoryLayer),
        Layer.provide(makeProjectMcpConfigServiceTestLayer()),
        Layer.provide(AnalyticsService.layerTest),
      );

      secondCodex.startSession.mockClear();
      secondCodex.rollbackThread.mockClear();

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        yield* provider.rollbackConversation({
          threadId: started.session.threadId,
          numTurns: 1,
        });
      }).pipe(Effect.provide(secondProviderLayer));

      assert.equal(secondCodex.startSession.mock.calls.length, 1);
      const resumedStartInput = secondCodex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, process.cwd());
        assert.deepEqual(startPayload.resumeCursor, started.session.resumeCursor);
        assert.equal(startPayload.threadId, started.session.threadId);
      }
      assert.equal(secondCodex.rollbackThread.mock.calls.length, 1);
      const rollbackCall = secondCodex.rollbackThread.mock.calls[0];
      assert.equal(typeof rollbackCall?.[0], "string");
      assert.equal(rollbackCall?.[1], 1);

      fs.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
);

routing.layer("ProviderServiceLive routing", (it) => {
  it.effect("does not recover an idle or stopped binding just to interrupt", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("stop-without-recovery");
      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      yield* routing.codex.stopAll();
      routing.codex.startSession.mockClear();
      yield* provider.interruptTurn({ threadId });
      assert.equal(routing.codex.startSession.mock.calls.length, 0);
      yield* provider.stopSession({ threadId });
      yield* provider.interruptTurn({ threadId });
      assert.equal(routing.codex.startSession.mock.calls.length, 0);
    }),
  );

  it.effect("adds authorized local attachment paths only at the adapter boundary", () => {
    const codex = makeFakeCodexAdapter("codex");
    const layer = makeProviderServiceLayerForAdapters(new Map([["codex", codex.adapter]]));
    const attachment: ChatAttachment = {
      type: "image",
      id: "thread-provider-context-12345678-1234-1234-1234-123456789abc",
      name: "screen shot.png",
      mimeType: "image/png",
      sizeBytes: 4,
    };
    const attachmentPath = path.join(
      os.tmpdir(),
      `f5-provider-service-tests-${process.pid}`,
      "attachments",
      `${attachment.id}.png`,
    );

    return Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-provider-context");
      fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
      fs.writeFileSync(attachmentPath, Uint8Array.from([1, 2, 3, 4]));

      yield* provider.startSession(threadId, {
        threadId,
        provider: "codex",
        runtimeMode: "full-access",
      });
      yield* provider.sendTurn({
        threadId,
        input: "Inspect this image",
        attachments: [attachment],
      });

      const adapterInput = codex.sendTurn.mock.calls.at(-1)?.[0];
      assert.equal(adapterInput?.resolvedAttachments?.length, 1);
      assert.deepEqual(adapterInput?.resolvedAttachments?.[0], {
        ...attachment,
        localPath: attachmentPath,
      });
      yield* provider.respondToUserInput({
        threadId,
        requestId: asRequestId("answer-with-media"),
        answers: { choices: ["A", "B"], record: { answers: ["C"] }, scalar: "D" },
        attachments: [attachment],
      });
      assert.deepEqual(codex.respondToUserInput.mock.calls.at(-1)?.[2], {
        choices: { answers: ["A", "B", `saved at ${attachmentPath}`] },
        record: { answers: ["C", `saved at ${attachmentPath}`] },
        scalar: { answers: ["D", `saved at ${attachmentPath}`] },
      });
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (fs.existsSync(attachmentPath)) {
            fs.unlinkSync(attachmentPath);
          }
        }),
      ),
      Effect.provide(layer),
    );
  });

  for (const kind of ["codex", "claudeAgent", "opencode"] as const) {
    it.effect(`delivers 40 MiB PDF and HEIC paths plus image overflow to ${kind}`, () => {
      const adapter = makeFakeCodexAdapter(kind);
      const layer = makeProviderServiceLayerForAdapters(new Map([[kind, adapter.adapter]]));
      const threadId = asThreadId(`media-${kind}`);
      const root = path.join(
        os.tmpdir(),
        `f5-provider-service-tests-${process.pid}`,
        "attachments",
      );
      const attachments: ChatAttachment[] = [
        {
          type: "file",
          id: `${threadId}-12345678-1234-1234-1234-123456789abc`,
          name: "document.pdf",
          mimeType: "application/pdf",
          sizeBytes: 40 * 1024 * 1024,
        },
        {
          type: "file",
          id: `${threadId}-12345678-1234-1234-1234-123456789abd`,
          name: "photo.heic",
          mimeType: "application/octet-stream",
          sizeBytes: 16,
        },
        ...Array.from({ length: 21 }, (_, i) => ({
          type: "image" as const,
          id: `${threadId}-12345678-1234-1234-1234-${String(i).padStart(12, "0")}`,
          name: `${i}.png`,
          mimeType: "image/png",
          sizeBytes: 4,
        })),
      ];
      const files = attachments.map((file) =>
        path.join(
          root,
          `${file.id}${file.type === "image" ? ".png" : file.name.endsWith(".pdf") ? ".pdf" : ".bin"}`,
        ),
      );
      return Effect.gen(function* () {
        const provider = yield* ProviderService;
        fs.mkdirSync(root, { recursive: true });
        files.forEach((file, i) => {
          fs.writeFileSync(file, "file");
          fs.truncateSync(file, attachments[i]!.sizeBytes);
        });
        yield* provider.startSession(threadId, {
          threadId,
          provider: kind,
          runtimeMode: "full-access",
        });
        yield* provider.sendTurn({ threadId, input: "Inspect these files", attachments });
        const sent = adapter.sendTurn.mock.calls.at(-1)?.[0];
        assert.equal(sent?.resolvedAttachments?.length, 23);
        assert.equal(sent?.attachments?.filter((file) => file.type === "image").length, 20);
        assert.equal(
          sent?.attachments?.filter((file) => file.type === "file").length,
          kind === "opencode" ? 1 : 0,
        );
        assert.deepEqual(
          sent?.resolvedAttachments?.map((file) => file.localPath),
          files,
        );
      }).pipe(
        Effect.ensuring(
          Effect.sync(() =>
            files.forEach((file) => {
              if (fs.existsSync(file)) fs.unlinkSync(file);
            }),
          ),
        ),
        Effect.provide(layer),
      );
    });
  }

  it.effect("fails the turn when a referenced attachment file is missing", () => {
    const codex = makeFakeCodexAdapter("codex");
    const layer = makeProviderServiceLayerForAdapters(new Map([["codex", codex.adapter]]));
    const attachment: ChatAttachment = {
      type: "image",
      id: "thread-missing-context-12345678-1234-1234-1234-123456789abc",
      name: "missing.png",
      mimeType: "image/png",
      sizeBytes: 4,
    };

    return Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-missing-context");
      yield* provider.startSession(threadId, {
        threadId,
        provider: "codex",
        runtimeMode: "full-access",
      });
      const result = yield* provider
        .sendTurn({
          threadId,
          input: "Inspect this image",
          attachments: [attachment],
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "ProviderValidationError");
        assert.match(result.failure.message, /no longer available/);
      }
      assert.equal(codex.sendTurn.mock.calls.length, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects unsupported runtime modes before starting a provider", () => {
    const cursor = makeFakeCodexAdapter("cursor");
    const layer = makeProviderServiceLayerForAdapters(new Map([["cursor", cursor.adapter]]));

    return Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-cursor-auto");
      const result = yield* provider
        .startSession(threadId, {
          threadId,
          provider: "cursor",
          runtimeMode: "auto",
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "ProviderValidationError");
        assert.equal(result.failure.message.includes("Auto review is not available"), true);
      }
      assert.equal(cursor.startSession.mock.calls.length, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("stops stale cross-provider sessions before starting a new provider session", () => {
    const codex = makeFakeCodexAdapter("codex");
    const claude = makeFakeCodexAdapter("claudeAgent");
    const layer = makeProviderServiceLayerForAdapters(
      new Map([
        ["codex", codex.adapter],
        ["claudeAgent", claude.adapter],
      ]),
    );

    return Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-cross-provider");

      yield* claude.adapter.startSession({
        threadId,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* provider.startSession(threadId, {
        threadId,
        provider: "codex",
        runtimeMode: "full-access",
      });

      assert.equal(claude.stopSession.mock.calls.length, 1);
      assert.deepEqual(claude.stopSession.mock.calls[0], [threadId]);
      assert.equal(codex.startSession.mock.calls.length, 1);

      const reverseThreadId = asThreadId("thread-cross-provider-reverse");
      yield* codex.adapter.startSession({
        threadId: reverseThreadId,
        provider: "codex",
        runtimeMode: "full-access",
      });

      yield* provider.startSession(reverseThreadId, {
        threadId: reverseThreadId,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      assert.deepEqual(codex.stopSession.mock.calls[0], [reverseThreadId]);
      assert.equal(claude.startSession.mock.calls.length, 2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not start a new provider session when stale cross-provider cleanup fails", () => {
    const codex = makeFakeCodexAdapter("codex");
    const claude = makeFakeCodexAdapter("claudeAgent");
    claude.stopSession.mockImplementation((threadId) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "claudeAgent",
          method: "stopSession",
          detail: `failed to stop ${threadId}`,
        }),
      ),
    );
    const layer = makeProviderServiceLayerForAdapters(
      new Map([
        ["codex", codex.adapter],
        ["claudeAgent", claude.adapter],
      ]),
    );

    return Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-cross-provider-failure");

      yield* claude.adapter.startSession({
        threadId,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const result = yield* Effect.result(
        provider.startSession(threadId, {
          threadId,
          provider: "codex",
          runtimeMode: "full-access",
        }),
      );

      assert.equal(result._tag, "Failure");
      assert.equal(codex.startSession.mock.calls.length, 0);
      assert.equal(claude.stopSession.mock.calls.length, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("records observability metrics for provider session, turn, and runtime events", () =>
    Effect.gen(function* () {
      const before = yield* Metric.snapshot;
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-observability");

      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        cwd: process.cwd(),
        model: "gpt-5-codex",
        runtimeMode: "full-access",
      });
      yield* provider.sendTurn({
        threadId,
        input: "hello observability",
        model: "gpt-5-codex",
        attachments: [],
      });

      const after = yield* Metric.snapshot;
      assert.equal(
        counterValue(after, "t3_provider_sessions_total", {
          provider: "codex",
          operation: "start",
          outcome: "success",
        }) -
          counterValue(before, "t3_provider_sessions_total", {
            provider: "codex",
            operation: "start",
            outcome: "success",
          }),
        1,
      );
      assert.equal(
        counterValue(after, "t3_provider_turns_total", {
          provider: "codex",
          modelFamily: "gpt",
          operation: "send",
          outcome: "success",
        }) -
          counterValue(before, "t3_provider_turns_total", {
            provider: "codex",
            modelFamily: "gpt",
            operation: "send",
            outcome: "success",
          }),
        1,
      );
      assert.equal(
        histogramCount(after, "t3_provider_turn_duration", {
          provider: "codex",
          modelFamily: "gpt",
          operation: "send",
        }) -
          histogramCount(before, "t3_provider_turn_duration", {
            provider: "codex",
            modelFamily: "gpt",
            operation: "send",
          }),
        1,
      );

      yield* provider.stopSession({ threadId });
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();
      routing.codex.stopSession.mockClear();
    }),
  );

  it.effect("routes provider operations, preserves stopped bindings, and recovers after stop", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: "codex",
        threadId: asThreadId("thread-1"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      assert.equal(session.provider, "codex");

      const sessions = yield* provider.listSessions();
      assert.equal(sessions.length, 1);

      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);

      yield* provider.interruptTurn({ threadId: session.threadId });
      assert.deepEqual(routing.codex.interruptTurn.mock.calls, [[session.threadId, undefined]]);

      yield* provider.respondToRequest({
        threadId: session.threadId,
        requestId: asRequestId("req-1"),
        decision: "accept",
      });
      assert.deepEqual(routing.codex.respondToRequest.mock.calls, [
        [session.threadId, asRequestId("req-1"), "accept"],
      ]);

      yield* provider.respondToUserInput({
        threadId: session.threadId,
        requestId: asRequestId("req-user-input-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
      });
      assert.deepEqual(routing.codex.respondToUserInput.mock.calls, [
        [
          session.threadId,
          asRequestId("req-user-input-1"),
          {
            sandbox_mode: "workspace-write",
          },
        ],
      ]);

      yield* provider.rollbackConversation({
        threadId: session.threadId,
        numTurns: 0,
      });

      yield* provider.stopSession({ threadId: session.threadId });
      const stoppedRuntime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(stoppedRuntime), true);
      if (Option.isSome(stoppedRuntime)) {
        assert.equal(stoppedRuntime.value.status, "stopped");
        assert.match(stoppedRuntime.value.launchFingerprint ?? "", /^[a-f0-9]{64}$/);
        const payload = stoppedRuntime.value.runtimePayload;
        assert.equal(payload !== null && typeof payload === "object", true);
        if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
          const runtimePayload = payload as {
            activeTurnId?: string | null;
            lastRuntimeEvent?: string | null;
          };
          assert.equal(runtimePayload.activeTurnId, `turn-${String(session.threadId)}`);
          assert.equal(runtimePayload.lastRuntimeEvent, "provider.stopSession");
        }
      }

      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      const sendAfterStop = yield* provider.sendTurn({
        threadId: session.threadId,
        input: "after-stop",
        attachments: [],
      });
      assert.equal(sendAfterStop.threadId, session.threadId);
      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("routes provider thread reads and recovers stale sessions before reading", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-read"), {
        provider: "codex",
        threadId: asThreadId("thread-read"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const firstSnapshot = yield* provider.readThread(session.threadId);
      assert.equal(firstSnapshot.threadId, session.threadId);
      assert.equal(routing.codex.readThread.mock.calls.length, 1);
      assert.deepEqual(routing.codex.readThread.mock.calls[0], [session.threadId]);

      yield* routing.codex.stopAll();
      routing.codex.startSession.mockClear();
      routing.codex.readThread.mockClear();

      const recoveredSnapshot = yield* provider.readThread(session.threadId);
      assert.equal(recoveredSnapshot.threadId, session.threadId);
      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      assert.equal(routing.codex.readThread.mock.calls.length, 1);
      assert.deepEqual(routing.codex.readThread.mock.calls[0], [session.threadId]);
    }),
  );

  it.effect("settles a persisted active turn before recovering its provider session", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-orphaned-recovery");
      const session = yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* provider.sendTurn({
        threadId,
        input: "keep working",
        attachments: [],
      });

      const terminalEventFiber = yield* Stream.runHead(
        Stream.filter(provider.streamEvents, (event) => event.type === "session.exited"),
      ).pipe(Effect.forkChild);
      yield* sleep(20);
      yield* routing.codex.stopAll();
      routing.codex.startSession.mockClear();

      yield* provider.readThread(threadId);
      const terminalEvent = Option.getOrUndefined(yield* Fiber.join(terminalEventFiber));

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      assert.equal(terminalEvent?.type, "session.exited");
      assert.equal(terminalEvent?.threadId, threadId);
      assert.equal(terminalEvent?.turnId, turn.turnId);
      assert.equal(
        terminalEvent?.eventId,
        `provider:orphaned-session-exit:${threadId}:${turn.turnId}`,
      );
      assert.equal(session.resumeCursor !== undefined, true);
    }),
  );

  it.effect("refuses mismatched recovery evidence and forwards the explicit interrupt", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-orphaned-mismatch");
      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      yield* provider.sendTurn({
        threadId,
        input: "keep working",
        attachments: [],
      });
      yield* routing.codex.stopAll();
      routing.codex.interruptTurn.mockClear();

      const projectedTurnId = asTurnId("turn-from-projection");
      yield* provider.interruptTurn({ threadId, turnId: projectedTurnId });

      assert.deepEqual(routing.codex.interruptTurn.mock.calls, [[threadId, projectedTurnId]]);
    }),
  );

  it.effect("recovers stale persisted sessions for rollback by resuming thread identity", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-1"), {
        provider: "codex",
        threadId: asThreadId("thread-1"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* routing.codex.stopSession(initial.threadId);
      routing.codex.startSession.mockClear();
      routing.codex.rollbackThread.mockClear();

      yield* provider.rollbackConversation({
        threadId: initial.threadId,
        numTurns: 1,
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, process.cwd());
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.codex.rollbackThread.mock.calls.length, 1);
      const rollbackCall = routing.codex.rollbackThread.mock.calls[0];
      assert.equal(rollbackCall?.[1], 1);
    }),
  );

  it.effect("recovers stale sessions for sendTurn using persisted cwd", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-1"), {
        provider: "codex",
        threadId: asThreadId("thread-1"),
        cwd: process.cwd(),
        model: "gpt-5.3-codex",
        modelOptions: { codex: { reasoningEffort: "high" } },
        providerOptions: { codex: { homePath: "/tmp/codex-recovery-home" } },
        projectTitle: "Project title",
        threadTitle: "Recovery thread",
        priorWorkSummary: "Earlier work",
        runtimeMode: "full-access",
      });

      yield* routing.codex.stopAll();
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume",
        attachments: [],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          projectTitle?: string;
          threadTitle?: string;
          priorWorkSummary?: string;
          model?: string;
          modelOptions?: { codex?: { reasoningEffort?: string } };
          providerOptions?: { codex?: { homePath?: string } };
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, process.cwd());
        assert.equal(startPayload.projectTitle, "Project title");
        assert.equal(startPayload.threadTitle, "Recovery thread");
        assert.equal(startPayload.priorWorkSummary, "Earlier work");
        assert.equal(startPayload.model, "gpt-5.3-codex");
        assert.equal(startPayload.modelOptions?.codex?.reasoningEffort, "high");
        assert.equal(startPayload.providerOptions?.codex?.homePath, "/tmp/codex-recovery-home");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("preserves Codex recovery context after the first turn", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      const initial = yield* provider.startSession(asThreadId("thread-first-turn"), {
        provider: "codex",
        threadId: asThreadId("thread-first-turn"),
        cwd: process.cwd(),
        projectTitle: "Project title",
        priorWorkSummary: "Earlier work",
        restoredTasks: ["[pending] Finish the task"],
        providerOptions: {
          codex: {
            homePath: "/tmp/codex-home",
          },
        },
        runtimeMode: "full-access",
      });
      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "hello",
        attachments: [],
      });

      const persistedRuntime = yield* runtimeRepository.getByThreadId({
        threadId: initial.threadId,
      });
      assert.equal(Option.isSome(persistedRuntime), true);
      if (Option.isSome(persistedRuntime)) {
        const payload = persistedRuntime.value.runtimePayload;
        assert.equal(payload !== null && typeof payload === "object", true);
        if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
          const runtimePayload = payload as {
            firstTurnSent?: boolean;
          };
          assert.equal(runtimePayload.firstTurnSent, true);
        }
      }

      yield* routing.codex.stopAll();
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume",
        attachments: [],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          projectTitle?: string;
          priorWorkSummary?: string;
          restoredTasks?: ReadonlyArray<string>;
          cwd?: string;
          providerOptions?: {
            codex?: {
              homePath?: string;
            };
          };
        };
        assert.equal(startPayload.projectTitle, "Project title");
        assert.equal(startPayload.priorWorkSummary, "Earlier work");
        assert.deepEqual(startPayload.restoredTasks, ["[pending] Finish the task"]);
        assert.equal(startPayload.cwd, process.cwd());
        assert.equal(startPayload.providerOptions?.codex?.homePath, "/tmp/codex-home");
      }

      yield* routing.codex.stopAll();
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume again",
        attachments: [],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const secondResumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(
        typeof secondResumedStartInput === "object" && secondResumedStartInput !== null,
        true,
      );
      if (secondResumedStartInput && typeof secondResumedStartInput === "object") {
        const startPayload = secondResumedStartInput as {
          projectTitle?: string;
          priorWorkSummary?: string;
          restoredTasks?: ReadonlyArray<string>;
          cwd?: string;
          providerOptions?: {
            codex?: {
              homePath?: string;
            };
          };
        };
        assert.equal(startPayload.projectTitle, "Project title");
        assert.equal(startPayload.priorWorkSummary, "Earlier work");
        assert.deepEqual(startPayload.restoredTasks, ["[pending] Finish the task"]);
        assert.equal(startPayload.cwd, process.cwd());
        assert.equal(startPayload.providerOptions?.codex?.homePath, "/tmp/codex-home");
      }
    }),
  );

  it.effect("preserves absent start config fields and records sanitized clears as null", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;
      const threadId = asThreadId("thread-start-config");

      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        model: "gpt-5.3-codex",
        modelOptions: { codex: { reasoningEffort: "high" } },
        providerOptions: { codex: { homePath: "/tmp/codex-start-config" } },
        runtimeMode: "full-access",
      });
      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        providerOptions: undefined,
        runtimeMode: "full-access",
      });

      const preserved = yield* runtimeRepository.getByThreadId({ threadId });
      assert.equal(Option.isSome(preserved), true);
      if (Option.isSome(preserved)) {
        const payload = preserved.value.runtimePayload as {
          startConfig?: Record<string, unknown>;
        };
        assert.deepEqual(payload.startConfig, {
          providerOptions: { codex: { homePath: "/tmp/codex-start-config" } },
          modelOptions: { codex: { reasoningEffort: "high" } },
          model: "gpt-5.3-codex",
        });
      }

      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        providerOptions: {
          mcpServers: {
            filesystem: { type: "stdio", command: "node" },
          },
        },
        runtimeMode: "full-access",
      });

      const cleared = yield* runtimeRepository.getByThreadId({ threadId });
      assert.equal(Option.isSome(cleared), true);
      if (Option.isSome(cleared)) {
        const payload = cleared.value.runtimePayload as {
          startConfig?: Record<string, unknown>;
        };
        assert.deepEqual(payload.startConfig, {
          providerOptions: null,
          modelOptions: { codex: { reasoningEffort: "high" } },
          model: "gpt-5.3-codex",
        });
      }
    }),
  );

  it.effect("lists no sessions after adapter runtime clears", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      yield* provider.startSession(asThreadId("thread-1"), {
        provider: "codex",
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });
      yield* provider.startSession(asThreadId("thread-2"), {
        provider: "codex",
        threadId: asThreadId("thread-2"),
        runtimeMode: "full-access",
      });

      yield* routing.codex.stopAll();

      const remaining = yield* provider.listSessions();
      assert.equal(remaining.length, 0);
    }),
  );

  it.effect("persists runtime status transitions in provider_session_runtime", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: "codex",
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });
      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      const runningRuntime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runningRuntime), true);
      if (Option.isSome(runningRuntime)) {
        assert.equal(runningRuntime.value.status, "running");
        assert.deepEqual(runningRuntime.value.resumeCursor, session.resumeCursor);
        const payload = runningRuntime.value.runtimePayload;
        assert.equal(payload !== null && typeof payload === "object", true);
        if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
          const runtimePayload = payload as {
            cwd: string;
            model: string | null;
            activeTurnId: string | null;
            lastError: string | null;
            lastRuntimeEvent: string | null;
          };
          assert.equal(runtimePayload.cwd, process.cwd());
          assert.equal(runtimePayload.model, null);
          assert.equal(runtimePayload.activeTurnId, `turn-${String(session.threadId)}`);
          assert.equal(runtimePayload.lastError, null);
          assert.equal(runtimePayload.lastRuntimeEvent, "provider.sendTurn");
        }
      }
    }),
  );
});

let terminalReceiptPersisted = false;
const durableFanout = makeProviderServiceLayer({
  recordTerminalEvent: () =>
    Effect.sync(() => {
      terminalReceiptPersisted = true;
    }),
});
durableFanout.layer("ProviderServiceLive durable terminal fanout", (it) => {
  it.effect("persists terminal events before subscribers observe them", () =>
    Effect.gen(function* () {
      terminalReceiptPersisted = false;
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-durable-terminal"), {
        provider: "codex",
        threadId: asThreadId("thread-durable-terminal"),
        runtimeMode: "full-access",
      });
      const observedPersistedState = yield* Ref.make(false);
      const consumer = yield* Stream.take(provider.streamEvents, 1).pipe(
        Stream.runForEach(() => Ref.set(observedPersistedState, terminalReceiptPersisted)),
        Effect.forkChild,
      );
      yield* sleep(20);

      durableFanout.codex.emit({
        type: "turn.completed",
        eventId: asEventId("evt-durable-terminal"),
        provider: "codex",
        createdAt: new Date().toISOString(),
        threadId: session.threadId,
        turnId: asTurnId("turn-durable-terminal"),
        payload: { state: "completed" },
      });

      yield* Fiber.join(consumer);
      assert.equal(yield* Ref.get(observedPersistedState), true);
    }),
  );
});

const fanout = makeProviderServiceLayer();
fanout.layer("ProviderServiceLive fanout", (it) => {
  it.effect("fans out adapter turn completion events", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: "codex",
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });

      const eventsRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.runForEach(provider.streamEvents, (event) =>
        Ref.update(eventsRef, (current) => [...current, event]),
      ).pipe(Effect.forkChild);
      yield* sleep(20);

      const completedEvent: LegacyProviderRuntimeEvent = {
        type: "turn.completed",
        eventId: asEventId("evt-1"),
        provider: "codex",
        createdAt: new Date().toISOString(),
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        status: "completed",
      };

      fanout.codex.emit(completedEvent);
      yield* sleep(20);

      const events = yield* Ref.get(eventsRef);
      yield* Fiber.interrupt(consumer);

      assert.equal(
        events.some((entry) => entry.type === "turn.completed"),
        true,
      );
    }),
  );

  it.effect("persists resume cursor updates carried on runtime events", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const session = yield* provider.startSession(asThreadId("thread-resume-cursor"), {
        provider: "codex",
        threadId: asThreadId("thread-resume-cursor"),
        runtimeMode: "full-access",
      });

      fanout.codex.emit({
        type: "turn.completed",
        eventId: asEventId("evt-resume-cursor"),
        provider: "codex",
        createdAt: new Date().toISOString(),
        threadId: session.threadId,
        turnId: asTurnId("turn-resume-cursor"),
        resumeCursor: {
          opaque: "cursor-after-turn",
          turnCount: 1,
        },
        payload: {
          state: "completed",
        },
      });
      yield* sleep(20);

      const binding = yield* directory.getBinding(session.threadId);
      assert.equal(Option.isSome(binding), true);
      if (Option.isSome(binding)) {
        assert.deepEqual(binding.value.resumeCursor, {
          opaque: "cursor-after-turn",
          turnCount: 1,
        });
      }
    }),
  );

  it.effect("fans out canonical runtime events in emission order", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-seq"), {
        provider: "codex",
        threadId: asThreadId("thread-seq"),
        runtimeMode: "full-access",
      });

      const receivedRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.take(provider.streamEvents, 3).pipe(
        Stream.runForEach((event) => Ref.update(receivedRef, (current) => [...current, event])),
        Effect.forkChild,
      );
      yield* sleep(20);

      fanout.codex.emit({
        type: "tool.started",
        eventId: asEventId("evt-seq-1"),
        provider: "codex",
        createdAt: new Date().toISOString(),
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        toolKind: "command",
        title: "Ran command",
      });
      fanout.codex.emit({
        type: "tool.completed",
        eventId: asEventId("evt-seq-2"),
        provider: "codex",
        createdAt: new Date().toISOString(),
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        toolKind: "command",
        title: "Ran command",
      });
      fanout.codex.emit({
        type: "turn.completed",
        eventId: asEventId("evt-seq-3"),
        provider: "codex",
        createdAt: new Date().toISOString(),
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        status: "completed",
      });

      yield* Fiber.join(consumer);
      const received = yield* Ref.get(receivedRef);
      assert.deepEqual(
        received.map((event) => event.eventId),
        [asEventId("evt-seq-1"), asEventId("evt-seq-2"), asEventId("evt-seq-3")],
      );
    }),
  );

  it.effect("keeps subscriber delivery ordered and isolates failing subscribers", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: "codex",
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });

      const receivedByHealthy: string[] = [];
      const expectedEventIds = new Set<string>(["evt-ordered-1", "evt-ordered-2", "evt-ordered-3"]);
      const healthyFiber = yield* Stream.take(provider.streamEvents, 3).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            receivedByHealthy.push(event.eventId);
          }),
        ),
        Effect.forkChild,
      );
      const failingFiber = yield* Stream.take(provider.streamEvents, 1).pipe(
        Stream.runForEach(() => Effect.fail("listener crash")),
        Effect.forkChild,
      );
      yield* sleep(20);

      const events: ReadonlyArray<LegacyProviderRuntimeEvent> = [
        {
          type: "tool.completed",
          eventId: asEventId("evt-ordered-1"),
          provider: "codex",
          createdAt: new Date().toISOString(),
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          toolKind: "command",
          title: "Ran command",
          detail: "echo one",
        },
        {
          type: "message.delta",
          eventId: asEventId("evt-ordered-2"),
          provider: "codex",
          createdAt: new Date().toISOString(),
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          delta: "hello",
        },
        {
          type: "turn.completed",
          eventId: asEventId("evt-ordered-3"),
          provider: "codex",
          createdAt: new Date().toISOString(),
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          status: "completed",
        },
      ];

      for (const event of events) {
        fanout.codex.emit(event);
      }
      const failingResult = yield* Effect.result(Fiber.join(failingFiber));
      assert.equal(failingResult._tag, "Failure");
      yield* Fiber.join(healthyFiber);

      assert.deepEqual(
        receivedByHealthy.filter((eventId) => expectedEventIds.has(eventId)).slice(0, 3),
        ["evt-ordered-1", "evt-ordered-2", "evt-ordered-3"],
      );
    }),
  );

  it.effect("skips stopped bindings when reloading MCP config for a project", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const projectId = ProjectId.makeUnsafe("project-reload");

      yield* directory.upsert({
        provider: "codex",
        projectId,
        threadId: asThreadId("thread-live"),
        status: "running",
        runtimeMode: "full-access",
        runtimePayload: {
          providerOptions: {
            codex: {
              binaryPath: "/tmp/codex",
              homePath: "/tmp/codex-home",
            },
          },
        },
      });

      yield* directory.upsert({
        provider: "codex",
        projectId,
        threadId: asThreadId("thread-stopped"),
        status: "stopped",
        runtimeMode: "full-access",
        runtimePayload: {
          providerOptions: {
            codex: {
              binaryPath: "/tmp/codex",
              homePath: "/tmp/codex-home",
            },
          },
        },
      });

      fanout.codex.reloadMcpConfig.mockReset();
      fanout.codex.reloadMcpConfig.mockImplementation(() => Effect.void);

      yield* provider.reloadMcpConfigForProject({
        provider: "codex",
        projectId,
        providerOptions: {
          codex: {
            binaryPath: "/tmp/codex",
            homePath: "/tmp/codex-home",
          },
        },
      });

      assert.equal(fanout.codex.reloadMcpConfig.mock.calls.length, 1);
      assert.deepEqual(fanout.codex.reloadMcpConfig.mock.calls[0], [asThreadId("thread-live")]);

      const updatedBinding = yield* directory.getBinding(asThreadId("thread-live"));
      assert.equal(Option.isSome(updatedBinding), true);
      if (Option.isSome(updatedBinding)) {
        assert.equal(updatedBinding.value.mcpEffectiveConfigVersion, "mcp-version-test");
      }
    }),
  );
});

const validation = makeProviderServiceLayer();
validation.layer("ProviderServiceLive validation", (it) => {
  it.effect("returns ProviderValidationError for invalid input payloads", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const failure = yield* Effect.result(
        provider.startSession(asThreadId("thread-validation"), {
          threadId: asThreadId("thread-validation"),
          provider: "invalid-provider",
          runtimeMode: "full-access",
        } as never),
      );

      assert.equal(failure._tag, "Failure");
      if (failure._tag !== "Failure") {
        return;
      }
      assert.equal(failure.failure._tag, "ProviderValidationError");
      if (failure.failure._tag !== "ProviderValidationError") {
        return;
      }
      assert.equal(failure.failure.operation, "ProviderService.startSession");
      assert.equal(failure.failure.issue.includes("invalid-provider"), true);
    }),
  );

  it.effect("returns concise validation errors for oversized turn input", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      validation.codex.sendTurn.mockClear();

      const failure = yield* Effect.result(
        provider.sendTurn({
          threadId: asThreadId("thread-validation-oversized"),
          input: "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS + 1),
        }),
      );

      assert.equal(failure._tag, "Failure");
      if (failure._tag !== "Failure") {
        return;
      }
      assert.equal(failure.failure._tag, "ProviderValidationError");
      if (failure.failure._tag !== "ProviderValidationError") {
        return;
      }
      assert.equal(failure.failure.operation, "ProviderService.sendTurn");
      assert.equal(failure.failure.issue.includes("120,000 character provider input limit"), true);
      assert.equal(failure.failure.issue.length < 240, true);
      assert.equal(validation.codex.sendTurn.mock.calls.length, 0);
    }),
  );

  it.effect("accepts startSession when adapter has not emitted provider thread id yet", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      validation.codex.startSession.mockImplementationOnce((input: ProviderSessionStartInput) =>
        Effect.sync(() => {
          const now = new Date().toISOString();
          return {
            provider: "codex",
            status: "ready",
            threadId: input.threadId,
            runtimeMode: input.runtimeMode,
            cwd: input.cwd ?? process.cwd(),
            createdAt: now,
            updatedAt: now,
          } satisfies ProviderSession;
        }),
      );

      const session = yield* provider.startSession(asThreadId("thread-missing"), {
        provider: "codex",
        threadId: asThreadId("thread-missing"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      assert.equal(session.threadId, asThreadId("thread-missing"));

      const runtime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.threadId, session.threadId);
      }
    }),
  );
});

it.effect("blocks session creation and turn dispatch during an account change", () => {
  const fake = makeFakeCodexAdapter("antigravity");
  return Effect.gen(function* () {
    const service = yield* ProviderService;
    const threadId = asThreadId("account-guard");
    const instanceId = ProviderInstanceId.make("antigravity");
    yield* service.startSession(threadId, {
      threadId,
      providerInstanceId: instanceId,
      runtimeMode: "full-access",
    });
    const release = beginAccountChange(
      path.join(os.tmpdir(), `f5-provider-service-tests-${process.pid}`),
      instanceId,
    );
    try {
      const sendFailure = yield* service
        .sendTurn({ threadId, input: "hello", attachments: [] })
        .pipe(Effect.flip);
      assert.equal(sendFailure._tag, "ProviderValidationError");
      assert.match(sendFailure.message, /Account change in progress/);
      const startFailure = yield* service
        .startSession(asThreadId("blocked"), {
          threadId: asThreadId("blocked"),
          providerInstanceId: instanceId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.flip);
      assert.match(startFailure.message, /Account change in progress/);
      assert.equal(fake.sendTurn.mock.calls.length, 0);
      assert.equal(fake.startSession.mock.calls.length, 1);
    } finally {
      release();
    }
    yield* service.sendTurn({ threadId, input: "hello", attachments: [] });
    assert.equal(fake.sendTurn.mock.calls.length, 1);
  }).pipe(
    Effect.provide(makeProviderServiceLayerForAdapters(new Map([["antigravity", fake.adapter]]))),
  );
});

it.effect("uses the admitted binding without rereading routing during send", () => {
  const fake = makeFakeCodexAdapter();
  return Effect.gen(function* () {
    const service = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const threadId = asThreadId("stable-admission");
    yield* service.startSession(threadId, {
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeMode: "full-access",
    });
    const original = directory.getBinding.bind(directory);
    let reads = 0;
    const spy = vi.spyOn(directory, "getBinding").mockImplementation((id) => {
      reads++;
      // A second routing read simulates a concurrent removal/rebind.
      return reads === 1 ? original(id) : Effect.succeed(Option.none());
    });
    try {
      yield* service.sendTurn({ threadId, input: "hello", attachments: [] });
      // One admission read and one post-dispatch persistence read.
      assert.equal(reads, 2);
      assert.equal(fake.sendTurn.mock.calls.length, 1);
    } finally {
      spy.mockRestore();
    }
  }).pipe(Effect.provide(makeProviderServiceLayerForAdapters(new Map([["codex", fake.adapter]]))));
});

it.effect("does not mark an accepted running usage recovery for another restart continuation", () =>
  Effect.gen(function* () {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "f5-recovery-restart-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => fs.rmSync(tempDir, { recursive: true, force: true })),
    );
    const persistence = makeSqlitePersistenceLive(path.join(tempDir, "state.sqlite"));
    const repository = ProviderSessionRuntimeRepositoryLive.pipe(Layer.provide(persistence));
    const directory = ProviderSessionDirectoryLive.pipe(Layer.provide(repository));
    const codex = makeFakeCodexAdapter();
    const listReadySessions = codex.listSessions.getMockImplementation()!;
    codex.listSessions.mockImplementation(() =>
      listReadySessions().pipe(
        Effect.map((sessions) =>
          sessions.map((session) => ({
            ...session,
            status: "running" as const,
            activeTurnId: asTurnId(`turn-${session.threadId}`),
          })),
        ),
      ),
    );

    const registry = makeAdapterRegistryMock({ codex: codex.adapter });
    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(providerServiceConfigLayer),
      Layer.provide(Layer.succeed(ProviderAdapterRegistry, registry)),
      Layer.provide(directory),
      Layer.provide(makeProjectMcpConfigServiceTestLayer()),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(ServerSettingsService.layerTest({ resumeActiveTurnsAfterRestart: true })),
      Layer.provideMerge(persistence),
    );
    yield* Effect.gen(function* () {
      const service = yield* ProviderService;
      const sql = yield* SqlClient.SqlClient;
      const at = "2026-10-01T00:00:00Z";
      for (const id of ["recovering", "ordinary"]) {
        const threadId = asThreadId(id);
        yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model, created_at, last_interaction_at, updated_at) VALUES (${id}, 'project', ${id}, 'gpt-5', ${at}, ${at}, ${at})`;
        yield* service.startSession(threadId, {
          provider: "codex",
          cwd: process.cwd(),
          runtimeMode: "full-access",
          threadId,
        });
        const turn = yield* service.sendTurn({ threadId, input: "continue", attachments: [] });
        const pendingMessageId =
          id === "recovering" ? `usage-resume:${id}:instance:codex:turn:limited` : "user-message";
        yield* sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, started_at, checkpoint_files_json) VALUES (${id}, ${turn.turnId}, ${pendingMessageId}, 'running', ${at}, ${at}, '[]')`;
      }
      const sessions = yield* service.listSessions();
      assert.equal(sessions.filter((session) => session.activeTurnId !== undefined).length, 2);
    }).pipe(Effect.provide(providerLayer));
    // Disposing the production provider layer runs markRestartTurns before shutdown.
    const markers = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{
        readonly thread_id: string;
      }>`SELECT thread_id FROM restart_turn_markers ORDER BY thread_id`;
    }).pipe(Effect.provide(persistence));
    assert.deepEqual(
      markers.map((row) => row.thread_id),
      ["ordinary"],
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
