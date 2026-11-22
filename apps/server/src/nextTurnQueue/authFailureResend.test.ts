import {
  MessageId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type ThreadTurnStartCommand,
} from "@t3tools/contracts";
import { authFailureKey } from "@t3tools/shared/usageLimit";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { NextTurnQueueStore } from "./Services/NextTurnQueueStore.ts";
import { resendAuthFailedTurn, turnStartedWork } from "./authFailureResend.ts";

const threadId = ThreadId.makeUnsafe("auth-thread");
const failedTurn = TurnId.makeUnsafe("failed-turn");
const failure = {
  providerInstanceId: ProviderInstanceId.makeUnsafe("claude"),
  turnId: failedTurn,
  occurredAt: "2026-11-22T12:59:00.000Z",
};
const key = authFailureKey(failure)!;
const attachment = {
  type: "image" as const,
  id: "image-1",
  name: "shot.png",
  mimeType: "image/png",
  sizeBytes: 10,
};
const userMessage = (id: string, turnId: string | null, text: string, createdAt: string) => ({
  id: MessageId.makeUnsafe(id),
  role: "user" as const,
  text,
  turnId: turnId ? TurnId.makeUnsafe(turnId) : null,
  streaming: false,
  createdAt,
  updatedAt: createdAt,
});

function makeThread(
  patch: Record<string, unknown> = {},
  sessionPatch: Record<string, unknown> = {},
) {
  return {
    id: threadId,
    model: "claude-opus-5-5",
    runtimeMode: "full-access",
    interactionMode: "default",
    deletedAt: null,
    archivedAt: null,
    pendingUserInputs: [],
    activities: [],
    messages: [
      userMessage("earlier", "old-turn", "earlier", "2026-11-22T12:00:00.000Z"),
      {
        ...userMessage("failed", "failed-turn", "test", "2026-11-22T12:58:57.000Z"),
        attachments: [attachment],
      },
      // A steering message shares the active turn's id; it must not be picked.
      userMessage("steer", "failed-turn", "also do this", "2026-11-22T12:58:58.000Z"),
    ],
    session: {
      threadId,
      status: "error",
      activeTurnId: null,
      lastError: "Claude login expired",
      lastErrorId: "runtime-error",
      authFailure: failure,
      ...sessionPatch,
    },
    ...patch,
  };
}

type Harness = {
  thread: ReturnType<typeof makeThread> | null;
  submitted: ThreadTurnStartCommand[];
  queueItems: Array<{ status: string; lastErrorCode?: string }>;
  beforeInsert?: () => void;
};

function run(
  harness: Harness,
  options: {
    readonly expectedFailureKey?: string;
    readonly delivery?: Record<string, unknown> | null;
    readonly deliveryState?: string;
  } = {},
) {
  const engine = {
    getReadModel: () =>
      Effect.sync(
        () =>
          ({
            threads: harness.thread ? [harness.thread] : [],
          }) as unknown as OrchestrationReadModel,
      ),
  };
  const store = {
    listByThread: () => Effect.succeed({ items: harness.queueItems, state: { revision: 0 } }),
    getBySubmissionId: (id: string) =>
      Effect.succeed(harness.submitted.some((command) => command.commandId === id) ? {} : null),
    insertSubmission: (input: { command: ThreadTurnStartCommand }) =>
      Effect.sync(() => {
        harness.submitted.push(input.command);
        return { kind: "created" as const, item: {} };
      }),
  };
  const delivery =
    options.delivery === null
      ? null
      : {
          type: "thread.turn-start-requested",
          payload: {
            threadId,
            messageId: "failed",
            model: "claude-opus-5-5",
            modelSelection: { provider: "claudeAgent", model: "claude-opus-5-5" },
            runtimeMode: "approval-required",
            interactionMode: "default",
            workflowExecutionProfile: "unattended-readonly",
            createdAt: "2026-11-22T12:58:57.000Z",
            ...options.delivery,
          },
        };
  return Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      if (delivery)
        yield* sql`INSERT INTO provider_turn_deliveries(delivery_id, command_id, thread_id, message_id, state, provider_turn_id, event_json, created_at, updated_at)
          VALUES ('delivery-1', 'command-1', ${threadId}, 'failed', ${options.deliveryState ?? "accepted"}, ${failedTurn}, ${JSON.stringify(delivery)}, '2026-11-22T12:58:57.000Z', '2026-11-22T12:58:57.000Z')`;
      return yield* resendAuthFailedTurn(
        { threadId, expectedFailureKey: options.expectedFailureKey ?? key },
        () => "2026-11-22T13:05:00.000Z",
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(OrchestrationEngineService, engine as never),
          Layer.succeed(NextTurnQueueStore, store as never),
          SqlitePersistenceMemory,
        ),
      ),
    ),
  );
}

const harness = (thread = makeThread()): Harness => ({ thread, submitted: [], queueItems: [] });

describe("resendAuthFailedTurn", () => {
  it("queues the delivery's own message with its original profile, modes and model", async () => {
    const state = harness();
    expect(await run(state)).toEqual({ kind: "sent" });
    expect(state.submitted).toHaveLength(1);
    const command = state.submitted[0]!;
    expect(command.commandId).toBe(`auth-resend:${threadId}:${key}`);
    expect(command.message.text).toBe("test");
    expect(command.message.attachments).toEqual([attachment]);
    // Read from the failed delivery, not the thread's current settings.
    expect(command.workflowExecutionProfile).toBe("unattended-readonly");
    expect(command.runtimeMode).toBe("approval-required");
    expect(command.modelSelection).toMatchObject({ model: "claude-opus-5-5" });
  });

  it("reports an existing resend instead of claiming a second send", async () => {
    const state = harness();
    await run(state);
    expect(await run(state, { delivery: null })).toMatchObject({ kind: "ineligible" });
    expect(state.submitted).toHaveLength(1);
  });

  it("refuses when the turn had already run a tool", async () => {
    const state = harness(
      makeThread({
        activities: [{ id: "a", kind: "tool.started", turnId: failedTurn, summary: "Edit" }],
      }),
    );
    const result = await run(state);
    expect(result.kind).toBe("ineligible");
    expect(result.reason).toMatch(/already started working/);
    expect(state.submitted).toHaveLength(0);
  });

  it("refuses when the failed delivery cannot be found", async () => {
    const state = harness();
    expect((await run(state, { delivery: null })).kind).toBe("ineligible");
    expect(state.submitted).toHaveLength(0);
  });

  it("refuses when the turn id is unknown rather than guessing a message", async () => {
    const state = harness(makeThread({}, { authFailure: { ...failure, turnId: null } }));
    expect((await run(state)).kind).toBe("ineligible");
    expect(state.submitted).toHaveLength(0);
  });

  it("refuses a stale failure key", async () => {
    const state = harness();
    expect((await run(state, { expectedFailureKey: "stale" })).kind).toBe("ineligible");
    expect(state.submitted).toHaveLength(0);
  });

  it("waits while the thread is busy or has blocked work", async () => {
    const busy = harness(makeThread({}, { status: "running", activeTurnId: "other" }));
    expect((await run(busy)).kind).toBe("busy");
    const queued = harness();
    queued.queueItems = [{ status: "queued" }];
    expect((await run(queued)).kind).toBe("busy");
    expect([...busy.submitted, ...queued.submitted]).toHaveLength(0);
  });

  it("yields to a normal send admitted between the first read and the insert", async () => {
    const state = harness();
    let reads = 0;
    const thread = state.thread!;
    Object.defineProperty(state, "thread", {
      get: () =>
        ++reads === 1
          ? thread
          : { ...thread, session: { ...thread.session, status: "running", activeTurnId: "new" } },
    });
    expect((await run(state)).kind).toBe("busy");
    expect(state.submitted).toHaveLength(0);
  });

  it("is ineligible without a recorded auth failure", async () => {
    const state = harness(makeThread({}, { authFailure: null }));
    expect((await run(state)).kind).toBe("ineligible");
  });
});

describe("turnStartedWork", () => {
  it("counts streamed assistant text and tool activity, not the error itself", () => {
    const base = { messages: [], activities: [] } as never;
    expect(turnStartedWork(base, failedTurn)).toBe(false);
    expect(
      turnStartedWork(
        { messages: [], activities: [{ kind: "runtime.error", turnId: failedTurn }] } as never,
        failedTurn,
      ),
    ).toBe(false);
    expect(
      turnStartedWork(
        {
          messages: [{ role: "assistant", turnId: failedTurn, text: "Working on it" }],
          activities: [],
        } as never,
        failedTurn,
      ),
    ).toBe(true);
  });
});
