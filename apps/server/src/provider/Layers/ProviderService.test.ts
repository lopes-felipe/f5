import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  ProviderApprovalDecision,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderTurnStartResult,
} from "@t3tools/contracts";
import {
  ApprovalRequestId,
  EventId,
  ProjectId,
  type ProviderKind,
  ProviderSessionStartInput,
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
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { makeProviderServiceLive } from "./ProviderService.ts";
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
      input: ProviderSendTurnInput,
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

function makeProviderServiceLayer() {
  const codex = makeFakeCodexAdapter();
  const registry = makeAdapterRegistryMock({ codex: codex.adapter });

  const providerAdapterLayer = Layer.succeed(ProviderAdapterRegistry, registry);
  const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

  const layer = it.layer(
    Layer.mergeAll(
      makeProviderServiceLive().pipe(
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
) {
  const registry = makeAdapterRegistryMock(
    Object.fromEntries(adaptersByProvider) as KindAdapterMap,
  );

  const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

  return Layer.mergeAll(
    makeProviderServiceLive().pipe(
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

const routing = makeProviderServiceLayer();
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
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, firstRegistry)),
        Layer.provide(firstDirectoryLayer),
        Layer.provide(makeProjectMcpConfigServiceTestLayer()),
        Layer.provide(AnalyticsService.layerTest),
      );

      const startedSession = yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        const threadId = asThreadId("thread-1");
        return yield* provider.startSession(threadId, {
          provider: "codex",
          cwd: "/tmp/project",
          runtimeMode: "full-access",
          threadId,
        });
      }).pipe(Effect.provide(firstProviderLayer));

      const persistedAfterStopAll = yield* Effect.gen(function* () {
        const repository = yield* ProviderSessionRuntimeRepository;
        return yield* repository.getByThreadId({ threadId: startedSession.threadId });
      }).pipe(Effect.provide(runtimeRepositoryLayer));
      assert.equal(Option.isSome(persistedAfterStopAll), true);
      if (Option.isSome(persistedAfterStopAll)) {
        assert.equal(persistedAfterStopAll.value.status, "stopped");
        assert.deepEqual(persistedAfterStopAll.value.resumeCursor, startedSession.resumeCursor);
      }

      const secondCodex = makeFakeCodexAdapter();
      const secondRegistry = makeAdapterRegistryMock({ codex: secondCodex.adapter });
      const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const secondProviderLayer = makeProviderServiceLive().pipe(
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
          threadId: startedSession.threadId,
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
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, startedSession.resumeCursor);
        assert.equal(startPayload.threadId, startedSession.threadId);
      }
      assert.equal(secondCodex.rollbackThread.mock.calls.length, 1);
      const rollbackCall = secondCodex.rollbackThread.mock.calls[0];
      assert.equal(typeof rollbackCall?.[0], "string");
      assert.equal(rollbackCall?.[1], 1);

      fs.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
);

routing.layer("ProviderServiceLive routing", (it) => {
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
        cwd: "/tmp/project",
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
        cwd: "/tmp/project",
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
        const payload = stoppedRuntime.value.runtimePayload;
        assert.equal(payload !== null && typeof payload === "object", true);
        if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
          const runtimePayload = payload as {
            activeTurnId?: string | null;
            lastRuntimeEvent?: string | null;
          };
          assert.equal(runtimePayload.activeTurnId, null);
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
        cwd: "/tmp/project-read-thread",
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

  it.effect("recovers stale persisted sessions for rollback by resuming thread identity", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-1"), {
        provider: "codex",
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project",
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
        assert.equal(startPayload.cwd, "/tmp/project");
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
        cwd: "/tmp/project-send-turn",
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
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project-send-turn");
        assert.equal(startPayload.projectTitle, "Project title");
        assert.equal(startPayload.threadTitle, "Recovery thread");
        assert.equal(startPayload.priorWorkSummary, "Earlier work");
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
        cwd: "/tmp/project-first-turn",
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
        assert.equal(startPayload.cwd, "/tmp/project-first-turn");
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
        assert.equal(startPayload.cwd, "/tmp/project-first-turn");
        assert.equal(startPayload.providerOptions?.codex?.homePath, "/tmp/codex-home");
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
        cwd: "/tmp/project",
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
