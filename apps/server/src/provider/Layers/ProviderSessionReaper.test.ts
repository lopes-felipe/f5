import { ProjectId, ThreadId, type OrchestrationReadModel } from "@t3tools/contracts";
import { it, assert } from "@effect/vitest";
import { Effect, Fiber, Layer, Option, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vitest";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBindingWithMetadata,
  type ProviderSessionDirectoryShape,
} from "../Services/ProviderSessionDirectory.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import { ProviderSessionReaper } from "../Services/ProviderSessionReaper.ts";
import { makeProviderSessionReaperLive } from "./ProviderSessionReaper.ts";

const makeReadModel = (threadSessionActiveTurnId: string | null = null): OrchestrationReadModel =>
  ({
    snapshotSequence: 1,
    projects: [],
    threads: [
      {
        id: ThreadId.makeUnsafe("thread-idle"),
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Thread",
        model: "gpt-5-codex",
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        archivedAt: null,
        createdAt: "1970-01-01T00:00:00.000Z",
        lastInteractionAt: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z",
        deletedAt: null,
        estimatedContextTokens: null,
        modelContextWindowTokens: null,
        messages: [],
        proposedPlans: [],
        tasks: [],
        tasksTurnId: null,
        tasksUpdatedAt: null,
        compaction: null,
        sessionNotes: null,
        threadReferences: [],
        activities: [],
        checkpoints: [],
        session: {
          threadId: ThreadId.makeUnsafe("thread-idle"),
          status: threadSessionActiveTurnId ? "running" : "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: threadSessionActiveTurnId,
          lastError: null,
          updatedAt: "1970-01-01T00:00:00.000Z",
        },
      },
    ],
    planningWorkflows: [],
    codeReviewWorkflows: [],
    updatedAt: "1970-01-01T00:00:00.000Z",
  }) as unknown as OrchestrationReadModel;

const idleBinding: ProviderRuntimeBindingWithMetadata = {
  threadId: ThreadId.makeUnsafe("thread-idle"),
  projectId: null,
  provider: "codex",
  runtimeMode: "full-access",
  status: "running",
  lastSeenAt: "1970-01-01T00:00:00.000Z",
  resumeCursor: null,
  runtimePayload: null,
};

function makeLayer(input: {
  readonly readModel: OrchestrationReadModel;
  readonly stopSession: ProviderServiceShape["stopSession"];
  readonly listedBindings?: ReadonlyArray<ProviderRuntimeBindingWithMetadata>;
  readonly currentBinding?: Option.Option<ProviderRuntimeBindingWithMetadata>;
  readonly stopTimeoutMs?: number;
}) {
  const listedBindings = input.listedBindings ?? [idleBinding];
  const currentBinding = input.currentBinding ?? Option.some(idleBinding);
  const directory: ProviderSessionDirectoryShape = {
    upsert: () => Effect.void,
    getProvider: () => Effect.succeed("codex"),
    getBinding: () => Effect.succeed(currentBinding),
    listThreadIds: () => Effect.succeed([ThreadId.makeUnsafe("thread-idle")]),
    listBindings: () => Effect.succeed(listedBindings),
    listBindingsByProject: () => Effect.succeed([]),
  };
  const engine: OrchestrationEngineShape = {
    getReadModel: () => Effect.succeed(input.readModel),
    readEvents: () => Stream.empty,
    dispatch: () => Effect.succeed({ sequence: 1 }),
    streamDomainEvents: Stream.empty,
  };
  const provider = {
    stopSession: input.stopSession,
  } as unknown as ProviderServiceShape;

  return makeProviderSessionReaperLive({
    inactivityThresholdMs: 1,
    sweepIntervalMs: 1,
    stopTimeoutMs: input.stopTimeoutMs ?? 10_000,
  }).pipe(
    Layer.provide(Layer.succeed(ProviderSessionDirectory, directory)),
    Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
    Layer.provide(Layer.succeed(ProviderService, provider)),
  );
}

it.effect(
  "ProviderSessionReaperLive terminates idle sessions after the inactivity threshold",
  () => {
    const stopSession = vi.fn<ProviderServiceShape["stopSession"]>(() => Effect.void);

    return Effect.gen(function* () {
      const reaper = yield* ProviderSessionReaper;

      yield* TestClock.adjust("2 millis");
      yield* reaper.sweep();

      assert.strictEqual(stopSession.mock.calls.length, 1);
      assert.deepStrictEqual(stopSession.mock.calls[0]?.[0], {
        threadId: ThreadId.makeUnsafe("thread-idle"),
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          readModel: makeReadModel(),
          stopSession: stopSession as unknown as ProviderServiceShape["stopSession"],
        }),
      ),
    );
  },
);

it.effect("ProviderSessionReaperLive does not terminate sessions with an active turn", () => {
  const stopSession = vi.fn<ProviderServiceShape["stopSession"]>(() => Effect.void);

  return Effect.gen(function* () {
    const reaper = yield* ProviderSessionReaper;

    yield* TestClock.adjust("2 millis");
    yield* reaper.sweep();

    assert.strictEqual(stopSession.mock.calls.length, 0);
  }).pipe(
    Effect.provide(
      makeLayer({
        readModel: makeReadModel("turn-active"),
        stopSession: stopSession as unknown as ProviderServiceShape["stopSession"],
      }),
    ),
  );
});

it.effect("ProviderSessionReaperLive skips sessions whose binding changed during the sweep", () => {
  const stopSession = vi.fn<ProviderServiceShape["stopSession"]>(() => Effect.void);

  return Effect.gen(function* () {
    const reaper = yield* ProviderSessionReaper;

    yield* TestClock.adjust("2 millis");
    yield* reaper.sweep();

    assert.strictEqual(stopSession.mock.calls.length, 0);
  }).pipe(
    Effect.provide(
      makeLayer({
        readModel: makeReadModel(),
        currentBinding: Option.some({
          ...idleBinding,
          lastSeenAt: "1970-01-01T00:10:00.000Z",
        }),
        stopSession: stopSession as unknown as ProviderServiceShape["stopSession"],
      }),
    ),
  );
});

it.effect("ProviderSessionReaperLive skips stopped and invalid timestamp bindings", () => {
  const stopSession = vi.fn<ProviderServiceShape["stopSession"]>(() => Effect.void);

  return Effect.gen(function* () {
    const reaper = yield* ProviderSessionReaper;

    yield* TestClock.adjust("2 millis");
    yield* reaper.sweep();

    assert.strictEqual(stopSession.mock.calls.length, 0);
  }).pipe(
    Effect.provide(
      makeLayer({
        readModel: makeReadModel(),
        listedBindings: [
          {
            ...idleBinding,
            status: "stopped",
          },
          {
            ...idleBinding,
            threadId: ThreadId.makeUnsafe("thread-invalid-last-seen"),
            lastSeenAt: "not-a-date",
          },
        ],
        stopSession: stopSession as unknown as ProviderServiceShape["stopSession"],
      }),
    ),
  );
});

it.effect("ProviderSessionReaperLive continues after stopSession times out", () => {
  const stopSession = vi.fn<ProviderServiceShape["stopSession"]>(() => Effect.never);

  return Effect.gen(function* () {
    const reaper = yield* ProviderSessionReaper;

    yield* TestClock.adjust("2 millis");
    const fiber = yield* reaper.sweep().pipe(Effect.forkChild);
    yield* TestClock.adjust("2 millis");
    yield* Fiber.join(fiber);

    assert.strictEqual(stopSession.mock.calls.length, 1);
  }).pipe(
    Effect.provide(
      makeLayer({
        readModel: makeReadModel(),
        stopSession: stopSession as unknown as ProviderServiceShape["stopSession"],
        stopTimeoutMs: 1,
      }),
    ),
  );
});
