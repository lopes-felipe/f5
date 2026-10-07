import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type ThreadTurnStartCommand,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { vi } from "vitest";
import type { OrchestrationThread } from "@t3tools/contracts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { scheduleUsageLimitResumeFor } from "../usageLimitResume.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import fs from "node:fs";
import path from "node:path";

import ensureUsageLimitResumeSchema from "../../persistence/Migrations/103_UsageLimitResume.ts";
import { ServerConfig } from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  NextTurnQueueStore,
  type NextTurnQueueStoreShape,
} from "../Services/NextTurnQueueStore.ts";
import { NextTurnQueueStoreLive } from "./NextTurnQueueStore.ts";

const testLayer = NextTurnQueueStoreLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "f5-next-turn-queue-" })),
  Layer.provideMerge(NodeServices.layer),
);
const layer = it.layer(testLayer);

function command(index: number, threadId = ThreadId.makeUnsafe("queue-thread")) {
  const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
  return {
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe(`queue-command-${index}`),
    threadId,
    message: {
      messageId: MessageId.makeUnsafe(`queue-message-${index}`),
      role: "user",
      text: `Turn ${index}`,
      attachments: [],
    },
    provider: "codex",
    model: "gpt-5.1-codex",
    runtimeMode: "approval-required",
    interactionMode: "default",
    createdAt,
  } satisfies ThreadTurnStartCommand;
}

const seedThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = new Date().toISOString();
    yield* sql`
      INSERT OR IGNORE INTO projection_projects (
        project_id, title, workspace_root, default_model, scripts_json,
        created_at, updated_at, deleted_at
      ) VALUES (${ProjectId.makeUnsafe("queue-project")}, 'Queue project', '/tmp', NULL, '[]', ${now}, ${now}, NULL)
    `;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model, branch, worktree_path, latest_turn_id,
        archived_at, created_at, last_interaction_at, updated_at, deleted_at
      ) VALUES (
        ${threadId}, ${ProjectId.makeUnsafe("queue-project")}, 'Queue thread', 'gpt-5.1-codex',
        NULL, NULL, NULL, NULL, ${now}, ${now}, ${now}, NULL
      )
    `;
  });

const insert = (store: NextTurnQueueStoreShape, index: number, threadId: ThreadId) =>
  store.insertSubmission({
    submissionId: CommandId.makeUnsafe(`submission-${index}`),
    requestHash: `hash-${index}`,
    itemId: CommandId.makeUnsafe(`item-${index}`),
    command: command(index, threadId),
    atHead: false,
  });

layer("NextTurnQueueStore", (it) => {
  it.effect("keeps migration reruns safe and concurrent recovery inserts unique", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* NextTurnQueueStore;
      const threadId = ThreadId.makeUnsafe("usage-resume-concurrent");
      yield* seedThread(threadId);
      yield* ensureUsageLimitResumeSchema;
      yield* ensureUsageLimitResumeSchema;
      const columns = yield* sql<{
        name: string;
      }>`SELECT name FROM pragma_table_info('next_turn_queue')`;
      assert.ok(columns.some((column) => column.name === "schedule_reason"));
      const indexes = yield* sql<{
        name: string;
      }>`SELECT name FROM sqlite_master WHERE type='index' AND name='next_turn_queue_one_usage_resume'`;
      assert.equal(indexes.length, 1);
      const input = {
        command: command(9980, threadId),
        itemId: CommandId.makeUnsafe("resume-concurrent"),
        submissionId: CommandId.makeUnsafe("resume-concurrent-submission"),
        requestHash: "concurrent",
        limitKey: "instance:codex:turn:concurrent",
        providerInstanceId: "codex",
        source: "manual" as const,
        notBefore: new Date(Date.now() + 60_000).toISOString(),
      };
      const results = yield* Effect.all(
        [store.scheduleUsageLimitResume(input), store.scheduleUsageLimitResume(input)],
        { concurrency: 2 },
      );
      assert.deepEqual([...results].sort(), ["already_scheduled", "created"]);
      assert.equal((yield* store.listByThread(threadId)).items.length, 1);
    }),
  );

  it.effect(
    "retains scheduled history across fresh failure rows and applies the five-minute backoff",
    () =>
      Effect.gen(function* () {
        const store = yield* NextTurnQueueStore;
        const threadId = ThreadId.makeUnsafe("usage-resume-real-backoff");
        yield* seedThread(threadId);
        let nowMs = Date.parse("2026-10-07T12:00:00.000Z");
        const resetsAt = new Date(nowMs + 2_000).toISOString();
        const clock = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
        yield* Effect.gen(function* () {
          for (let index = 0; index < 3; index++) {
            const key = `instance:codex:turn:backoff-${index}`;
            yield* store.recordUsageResumeFailure(threadId, key, true);
            const thread = {
              id: threadId,
              model: "gpt-5.1-codex",
              runtimeMode: "approval-required",
              interactionMode: "default",
              session: {
                status: "error",
                activeTurnId: null,
                usageLimit: {
                  providerInstanceId: "codex",
                  turnId: `backoff-${index}`,
                  deliveryId: null,
                  windows: [],
                  resetsAt,
                  resetSource: "provider",
                  evidence: "typed",
                },
              },
            } as unknown as OrchestrationThread;
            const result = yield* scheduleUsageLimitResumeFor({
              threadId,
              source: "auto",
              thread,
            }).pipe(Effect.provideService(OrchestrationEngineService, {} as never));
            assert.equal(result.kind, index === 0 ? "created" : "rebound");
            const target = (yield* store.listByThread(threadId)).items[0]!.notBefore!;
            assert.equal(
              Date.parse(target) - nowMs,
              index === 0 ? 62_000 : index === 1 ? 60_000 : 300_000,
            );
            nowMs = Date.parse(target);
          }
        }).pipe(Effect.ensuring(Effect.sync(() => clock.mockRestore())));
      }),
  );

  it.effect("revokes the requested SQL scope without touching other automatic queues", () =>
    Effect.gen(function* () {
      const store = yield* NextTurnQueueStore;
      const ids = ["usage-scope-one", "usage-scope-two", "usage-scope-other"].map(
        ThreadId.makeUnsafe,
      );
      for (const [index, threadId] of ids.entries()) {
        yield* seedThread(threadId);
        yield* store.scheduleUsageLimitResume({
          command: command(9985 + index, threadId),
          itemId: CommandId.makeUnsafe(`scope-item-${index}`),
          submissionId: CommandId.makeUnsafe(`scope-submission-${index}`),
          requestHash: `scope-${index}`,
          limitKey: `instance:codex:turn:scope-${index}`,
          providerInstanceId: "codex",
          source: "auto",
          notBefore: new Date(Date.now() + 60_000).toISOString(),
        });
      }
      assert.deepEqual(yield* store.revokeAutoResumes(ids.slice(0, 2)), ids.slice(0, 2));
      assert.deepEqual(yield* store.revokeAutoResumes(ids.slice(0, 2)), []);
      assert.equal((yield* store.listByThread(ids[2]!)).items.length, 1);
    }),
  );

  it.effect("schedules once, survives cancellation, and only clears failure pauses", () =>
    Effect.gen(function* () {
      const store = yield* NextTurnQueueStore;
      const threadId = ThreadId.makeUnsafe("usage-resume-manual");
      yield* seedThread(threadId);
      const input = {
        command: { ...command(9901, threadId), presentation: "continuation" as const },
        itemId: CommandId.makeUnsafe("usage-resume-manual-item"),
        submissionId: CommandId.makeUnsafe("usage-resume-manual-submission"),
        requestHash: "resume-hash",
        limitKey: "instance:codex:turn:limited",
        providerInstanceId: "codex",
        source: "manual" as const,
        notBefore: new Date(Date.now() + 60_000).toISOString(),
      };
      yield* store.setPaused({ threadId, paused: true, reasonCode: "turn_failed" });
      assert.equal(yield* store.scheduleUsageLimitResume(input), "created");
      assert.equal(yield* store.scheduleUsageLimitResume(input), "already_scheduled");
      const queue = yield* store.listByThread(threadId);
      assert.equal(queue.state.paused, false);
      assert.equal(queue.items[0]?.scheduleReason, "usage_limit_reset");
      assert.equal(queue.items[0]?.notBefore, input.notBefore);
      yield* store.softDelete({ itemId: input.itemId });
      assert.equal((yield* store.getUsageResumeLedger(threadId))?.state, "cancelled");
      assert.equal(
        yield* store.scheduleUsageLimitResume({ ...input, source: "auto" }),
        "suppressed",
      );
      yield* store.setPaused({ threadId, paused: true, reasonCode: "manual_pause" });
      assert.equal(yield* store.scheduleUsageLimitResume(input), "rebound");
      assert.equal((yield* store.listByThread(threadId)).state.paused, true);
      assert.equal((yield* store.listByThread(threadId)).items.length, 1);
    }),
  );

  it.effect("persists the three-attempt guard and rebinds identity for subsequent failures", () =>
    Effect.gen(function* () {
      const store = yield* NextTurnQueueStore;
      const threadId = ThreadId.makeUnsafe("usage-resume-streak");
      yield* seedThread(threadId);
      for (let index = 0; index < 4; index++) {
        const key = `instance:codex:turn:limited-${index}`;
        yield* store.recordUsageResumeFailure(threadId, key, true);
        const input = {
          command: command(9910 + index, threadId),
          itemId: CommandId.makeUnsafe(`resume-streak-${index}`),
          submissionId: CommandId.makeUnsafe(`resume-streak-submission-${index}`),
          requestHash: `resume-${index}`,
          limitKey: key,
          providerInstanceId: "codex",
          source: "auto" as const,
          notBefore: new Date(Date.now() + 60_000).toISOString(),
        };
        assert.equal(
          yield* store.scheduleUsageLimitResume(input),
          index === 0 ? "created" : index === 3 ? "gave_up" : "rebound",
        );
        if (index < 3)
          assert.equal(
            (yield* store.listByThread(threadId)).items[0]?.command.commandId,
            input.command.commandId,
          );
      }
      assert.equal((yield* store.getUsageResumeLedger(threadId))?.state, "gave_up");
      assert.equal(
        (yield* store.getBySubmissionId(CommandId.makeUnsafe("resume-streak-submission-0")))
          ?.disposition,
        "canceled",
      );
      yield* store.resetUsageResumeStreak(threadId);
      yield* store.completeUsageResume(threadId);
      const key = "instance:codex:turn:after-success";
      yield* store.recordUsageResumeFailure(threadId, key, true);
      assert.equal(
        yield* store.scheduleUsageLimitResume({
          command: command(9920, threadId),
          itemId: CommandId.makeUnsafe("after-success"),
          submissionId: CommandId.makeUnsafe("after-success-submission"),
          requestHash: "after-success",
          limitKey: key,
          providerInstanceId: "codex",
          source: "auto",
          notBefore: new Date(Date.now() + 60_000).toISOString(),
        }),
        "created",
      );
    }),
  );

  it.effect(
    "completed recovery removes a stale head, leaves follow-ups, and suppresses automation",
    () =>
      Effect.gen(function* () {
        const store = yield* NextTurnQueueStore;
        const threadId = ThreadId.makeUnsafe("usage-resume-completed");
        yield* seedThread(threadId);
        const input = {
          command: command(9860, threadId),
          itemId: CommandId.makeUnsafe("completed-recovery"),
          submissionId: CommandId.makeUnsafe("completed-submission"),
          requestHash: "completed",
          limitKey: "instance:codex:turn:completed",
          providerInstanceId: "codex",
          source: "auto" as const,
          notBefore: new Date(Date.now() + 60_000).toISOString(),
        };
        yield* store.scheduleUsageLimitResume(input);
        yield* insert(store, 9861, threadId);
        yield* store.completeUsageResume(threadId);
        assert.equal((yield* store.listByThread(threadId)).items.length, 1);
        assert.equal((yield* store.listByThread(threadId)).items[0]?.position, 0);
        assert.equal((yield* store.getUsageResumeLedger(threadId))?.state, "completed");
        assert.equal(yield* store.scheduleUsageLimitResume(input), "suppressed");
      }),
  );

  it.effect(
    "a replay after accepted removal does not create a phantom schedule or consume the guard",
    () =>
      Effect.gen(function* () {
        const store = yield* NextTurnQueueStore;
        const threadId = ThreadId.makeUnsafe("usage-resume-replay");
        yield* seedThread(threadId);
        const input = {
          command: command(9862, threadId),
          itemId: CommandId.makeUnsafe("replay-recovery"),
          submissionId: CommandId.makeUnsafe("replay-submission"),
          requestHash: "replay",
          limitKey: "instance:codex:turn:replay",
          providerInstanceId: "codex",
          source: "auto" as const,
          notBefore: new Date(Date.now() - 1_000).toISOString(),
        };
        yield* store.scheduleUsageLimitResume(input);
        yield* store.claim({
          itemId: input.itemId,
          leaseOwner: "test",
          now: new Date().toISOString(),
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
        yield* store.complete({ itemId: input.itemId, leaseOwner: "test", sequence: 1 });
        const count = (yield* store.getUsageResumeLedger(threadId))?.autoCount;
        assert.equal(yield* store.scheduleUsageLimitResume(input), "already_scheduled");
        assert.equal((yield* store.listByThread(threadId)).items.length, 0);
        assert.equal((yield* store.getUsageResumeLedger(threadId))?.autoCount, count);
      }),
  );

  it.effect(
    "retargets an unadmitted failed recovery with fresh command and message identities",
    () =>
      Effect.gen(function* () {
        const store = yield* NextTurnQueueStore;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.makeUnsafe("usage-resume-failed-retarget");
        yield* seedThread(threadId);
        const input = {
          command: command(9863, threadId),
          itemId: CommandId.makeUnsafe("failed-retarget"),
          submissionId: CommandId.makeUnsafe("failed-retarget-submission"),
          requestHash: "retarget",
          limitKey: "instance:codex:turn:retarget",
          providerInstanceId: "codex",
          source: "manual" as const,
          notBefore: new Date(Date.now() + 60_000).toISOString(),
        };
        yield* store.scheduleUsageLimitResume(input);
        yield* sql`UPDATE next_turn_queue SET status='failed',attempt_count=1 WHERE item_id=${input.itemId}`;
        const target = new Date(Date.now() + 3_600_000).toISOString();
        assert.equal(
          yield* store.scheduleUsageLimitResume({ ...input, notBefore: target }),
          "rebound",
        );
        const item = (yield* store.listByThread(threadId)).items[0]!;
        assert.equal(item.status, "queued");
        assert.equal(item.notBefore, target);
        assert.notEqual(item.command.commandId, input.command.commandId);
        assert.notEqual(item.command.message.messageId, input.command.message.messageId);
        assert.equal((yield* store.getBySubmissionId(input.submissionId))?.disposition, "canceled");
      }),
  );

  it.effect("supersedes recovery on ordinary sends and preserves it for tail enqueues", () =>
    Effect.gen(function* () {
      const store = yield* NextTurnQueueStore;
      const threadId = ThreadId.makeUnsafe("usage-resume-supersede");
      yield* seedThread(threadId);
      const input = {
        command: command(9930, threadId),
        itemId: CommandId.makeUnsafe("resume-supersede"),
        submissionId: CommandId.makeUnsafe("resume-supersede-submission"),
        requestHash: "resume",
        limitKey: "instance:codex:turn:blocked",
        providerInstanceId: "codex",
        source: "manual" as const,
        notBefore: new Date(Date.now() + 60_000).toISOString(),
      };
      yield* store.scheduleUsageLimitResume(input);
      yield* insert(store, 9931, threadId);
      assert.equal((yield* store.listByThread(threadId)).items[0]?.itemId, input.itemId);
      yield* store.insertSubmission({
        command: command(9932, threadId),
        itemId: CommandId.makeUnsafe("supersede-send"),
        submissionId: CommandId.makeUnsafe("supersede-send-submission"),
        requestHash: "send",
        atHead: true,
        supersedeUsageResume: true,
      });
      assert.equal((yield* store.getUsageResumeLedger(threadId))?.state, "superseded");
      assert.equal(
        (yield* store.listByThread(threadId)).items.some(
          (item) => item.scheduleReason === "usage_limit_reset",
        ),
        false,
      );
    }),
  );

  it.effect("reserves one recovery slot and atomically clears the schedule on promote", () =>
    Effect.gen(function* () {
      const store = yield* NextTurnQueueStore;
      const threadId = ThreadId.makeUnsafe("usage-resume-full");
      yield* seedThread(threadId);
      for (let index = 9940; index < 9960; index++) yield* insert(store, index, threadId);
      const input = {
        command: command(9960, threadId),
        itemId: CommandId.makeUnsafe("resume-full"),
        submissionId: CommandId.makeUnsafe("resume-full-submission"),
        requestHash: "full",
        limitKey: "instance:codex:turn:full",
        providerInstanceId: "codex",
        source: "manual" as const,
        notBefore: new Date(Date.now() + 60_000).toISOString(),
      };
      assert.equal(yield* store.scheduleUsageLimitResume(input), "created");
      const queue = yield* store.listByThread(threadId);
      assert.equal(queue.items.length, 21);
      const stale = yield* Effect.exit(
        store.replacePositions({
          threadId,
          orderedItemIds: queue.items.map((item) => item.itemId),
          expectedRevision: queue.state.revision - 1,
          clearScheduleItemId: input.itemId,
        }),
      );
      assert.equal(stale._tag, "Failure");
      assert.equal((yield* store.getItem(input.itemId))?.notBefore, input.notBefore);
      yield* store.replacePositions({
        threadId,
        orderedItemIds: queue.items.map((item) => item.itemId),
        expectedRevision: queue.state.revision,
        clearScheduleItemId: input.itemId,
      });
      assert.equal((yield* store.getItem(input.itemId))?.notBefore, null);
    }),
  );

  it.effect("revokes only automatic schedules and never moves an item already sending", () =>
    Effect.gen(function* () {
      const store = yield* NextTurnQueueStore;
      const threadId = ThreadId.makeUnsafe("usage-resume-revoke");
      yield* seedThread(threadId);
      const input = {
        command: command(9970, threadId),
        itemId: CommandId.makeUnsafe("resume-revoke"),
        submissionId: CommandId.makeUnsafe("resume-revoke-submission"),
        requestHash: "revoke",
        limitKey: "instance:codex:turn:revoke",
        providerInstanceId: "codex",
        source: "auto" as const,
        notBefore: new Date(Date.now() + 60_000).toISOString(),
      };
      yield* store.scheduleUsageLimitResume(input);
      const summary = yield* store.summary;
      assert.equal(
        summary.threads.find((row) => row.threadId === threadId)?.scheduledResumeAt,
        input.notBefore,
      );
      yield* store.revokeAutoResumes([threadId]);
      assert.equal((yield* store.getUsageResumeLedger(threadId))?.state, "revoked");
      assert.equal((yield* store.listByThread(threadId)).items.length, 0);
      yield* store.scheduleUsageLimitResume({ ...input, source: "manual" });
      yield* store.revokeAutoResumes([threadId]);
      assert.equal((yield* store.listByThread(threadId)).items.length, 1);
      yield* store.rescheduleByInstance("codex", new Date(Date.now() - 1000).toISOString());
      yield* store.claim({
        itemId: input.itemId,
        leaseOwner: "owner",
        now: new Date().toISOString(),
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      assert.equal(
        (yield* store.rescheduleByInstance("codex", input.notBefore)).includes(threadId),
        false,
      );
      assert.equal(
        yield* store.scheduleUsageLimitResume({ ...input, limitKey: "instance:codex:turn:next" }),
        "busy",
      );
    }),
  );

  it.effect("returns a rejected steer to the head with the same durable identifiers", () =>
    Effect.gen(function* () {
      const store = yield* NextTurnQueueStore;
      const threadId = ThreadId.makeUnsafe("queue-steer-fallback");
      yield* seedThread(threadId);
      yield* insert(store, 801, threadId);
      const submitted = yield* insert(store, 802, threadId);
      if (submitted.kind !== "created") throw new Error("expected a new item");
      const original = submitted.item;
      const state = yield* store.listByThread(threadId);
      yield* store.setSteer(original.itemId, state.state.revision, TurnId.makeUnsafe("busy-turn"));
      yield* store.claim({
        itemId: original.itemId,
        leaseOwner: "steer-owner",
        now: new Date().toISOString(),
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      yield* store.fallbackSteer(original.command.commandId);
      const result = yield* store.listByThread(threadId);
      const item = result.items[0]!;
      assert.equal(item.itemId, original.itemId);
      assert.equal(item.submissionId, original.submissionId);
      assert.equal(item.command.commandId, original.command.commandId);
      assert.equal(item.command.message.messageId, original.command.message.messageId);
      assert.equal(item.command.expectedTurnId, undefined);
      assert.equal(item.status, "queued");
      assert.equal(item.lastErrorCode, "steer_queued");
    }),
  );

  it.effect("uses CAS claims and rejects edits or cancellation while dispatching", () =>
    Effect.gen(function* () {
      const store = yield* NextTurnQueueStore;
      const threadId = ThreadId.makeUnsafe("queue-cas-thread");
      yield* seedThread(threadId);
      const created = yield* insert(store, 1, threadId);
      assert.equal(created.kind, "created");
      if (created.kind !== "created") return;

      const first = yield* store.claim({
        itemId: created.item.itemId,
        leaseOwner: "owner-1",
        now: "2026-01-01T00:01:00.000Z",
        leaseExpiresAt: "2026-01-01T00:11:00.000Z",
      });
      const second = yield* store.claim({
        itemId: created.item.itemId,
        leaseOwner: "owner-2",
        now: "2026-01-01T00:01:00.000Z",
        leaseExpiresAt: "2026-01-01T00:11:00.000Z",
      });
      assert.equal(first?.leaseOwner, "owner-1");
      assert.equal(second, null);

      const cancelError = yield* store
        .softDelete({ itemId: created.item.itemId })
        .pipe(Effect.flip);
      assert.equal(cancelError._tag, "NextTurnQueueItemDispatchingError");
      const updateError = yield* store
        .updateCommand({
          itemId: created.item.itemId,
          expectedUpdatedAt: first!.item.updatedAt,
          update: (value) => value,
        })
        .pipe(Effect.flip);
      assert.equal(updateError._tag, "NextTurnQueueItemDispatchingError");
    }),
  );

  it.effect("rotates attempt identities and keeps the submission identity", () =>
    Effect.gen(function* () {
      const store = yield* NextTurnQueueStore;
      const threadId = ThreadId.makeUnsafe("queue-retry-thread");
      yield* seedThread(threadId);
      const created = yield* insert(store, 2, threadId);
      if (created.kind !== "created") return;
      yield* store.markFailed({
        itemId: created.item.itemId,
        leaseOwner: null,
        errorCode: "rejected",
        errorDetail: "rejected",
      });
      const failed = yield* store.getItem(created.item.itemId);
      const retried = yield* store.retry({
        itemId: created.item.itemId,
        expectedUpdatedAt: failed!.updatedAt,
      });
      assert.notEqual(retried.command.commandId, created.item.command.commandId);
      assert.notEqual(retried.command.message.messageId, created.item.command.message.messageId);
      assert.equal(retried.submissionId, created.item.submissionId);
      assert.equal(retried.attemptCount, 0);
      assert.equal(retried.dispatchStartedAt, null);
    }),
  );

  it.effect(
    "replays identical submissions, rejects changed hashes, and keeps revisions monotonic",
    () =>
      Effect.gen(function* () {
        const store = yield* NextTurnQueueStore;
        const threadId = ThreadId.makeUnsafe("queue-ledger-thread");
        yield* seedThread(threadId);
        const created = yield* insert(store, 3, threadId);
        assert.equal(created.kind, "created");
        const replay = yield* insert(store, 3, threadId);
        assert.equal(replay.kind, "replay");
        const conflict = yield* store
          .insertSubmission({
            submissionId: CommandId.makeUnsafe("submission-3"),
            requestHash: "changed",
            itemId: CommandId.makeUnsafe("other-item"),
            command: command(4, threadId),
            atHead: false,
          })
          .pipe(Effect.flip);
        assert.equal(conflict._tag, "NextTurnQueueIdempotencyConflictError");

        const before = yield* store.listByThread(threadId);
        yield* store.clear({ threadId, scope: "all", expectedRevision: before.state.revision });
        const empty = yield* store.listByThread(threadId);
        yield* insert(store, 5, threadId);
        const refilled = yield* store.listByThread(threadId);
        assert.equal(empty.items.length, 0);
        assert.equal(refilled.state.revision > empty.state.revision, true);
      }),
  );

  it.effect("quarantines malformed JSON without re-reading the invalid payload in SQLite", () =>
    Effect.gen(function* () {
      const store = yield* NextTurnQueueStore;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("queue-malformed-json-thread");
      yield* seedThread(threadId);
      const created = yield* insert(store, 6, threadId);
      if (created.kind !== "created") return;

      yield* sql`
        UPDATE next_turn_queue SET command_json = '{malformed'
        WHERE item_id = ${created.item.itemId}
      `;

      const first = yield* store.listByThread(threadId);
      assert.equal(first.items.length, 0);
      assert.equal(first.quarantinedCount, 1);
      const remaining = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM next_turn_queue WHERE thread_id = ${threadId}
      `;
      assert.equal(remaining[0]?.count ?? -1, 0);

      const second = yield* store.listByThread(threadId);
      assert.equal(second.items.length, 0);
      assert.equal(second.quarantinedCount, 1);
    }),
  );

  it.effect("never regresses a started submission when a timeout settles it as queued", () =>
    Effect.gen(function* () {
      const store = yield* NextTurnQueueStore;
      const threadId = ThreadId.makeUnsafe("queue-monotonic-ledger-thread");
      yield* seedThread(threadId);
      const created = yield* insert(store, 7, threadId);
      if (created.kind !== "created") return;

      yield* store.settleSubmission({
        submissionId: created.item.submissionId,
        result: {
          disposition: "started",
          submissionId: created.item.submissionId,
          sequence: 42,
        },
      });
      const data = yield* store.listByThread(threadId);
      yield* store.settleSubmission({
        submissionId: created.item.submissionId,
        result: {
          disposition: "queued",
          submissionId: created.item.submissionId,
          itemId: created.item.itemId,
          snapshot: {
            threadId,
            items: data.items,
            revision: data.state.revision,
            paused: data.state.paused,
            blockedKind: null,
            reasonCode: null,
            reasonDetail: null,
            maxItems: 20,
            quarantinedCount: data.quarantinedCount,
          },
        },
      });

      const ledger = yield* store.getBySubmissionId(created.item.submissionId);
      assert.equal(ledger?.disposition, "started");
      assert.equal(ledger?.resultSequence, 42);
    }),
  );

  it.effect("rejects every mutation that could replace an accepted attempted item", () =>
    Effect.gen(function* () {
      const store = yield* NextTurnQueueStore;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("queue-accepted-mutation-thread");
      yield* seedThread(threadId);
      const created = yield* insert(store, 8, threadId);
      if (created.kind !== "created") return;
      const claimed = yield* store.claim({
        itemId: created.item.itemId,
        leaseOwner: "accepted-owner",
        now: "2026-01-01T00:01:00.000Z",
        leaseExpiresAt: "2026-01-01T00:11:00.000Z",
      });
      assert.equal(claimed !== null, true);
      yield* store.markFailed({
        itemId: created.item.itemId,
        leaseOwner: "accepted-owner",
        errorCode: "dispatch_rejected",
        errorDetail: "recovered after commit",
      });
      yield* sql`
        INSERT INTO orchestration_command_receipts (
          command_id, aggregate_kind, aggregate_id, accepted_at,
          result_sequence, status, error
        ) VALUES (
          ${created.item.command.commandId}, 'thread', ${threadId},
          ${new Date().toISOString()}, 9, 'accepted', NULL
        )
      `;
      const failed = yield* store.getItem(created.item.itemId);
      assert.equal(failed !== null, true);

      const updateError = yield* store
        .updateCommand({
          itemId: created.item.itemId,
          expectedUpdatedAt: failed!.updatedAt,
          update: (value) => ({ ...value, message: { ...value.message, text: "changed" } }),
        })
        .pipe(Effect.flip);
      assert.equal(updateError._tag, "NextTurnQueueItemAlreadyRanError");

      const retryError = yield* store
        .retry({ itemId: created.item.itemId, expectedUpdatedAt: failed!.updatedAt })
        .pipe(Effect.flip);
      assert.equal(retryError._tag, "NextTurnQueueItemAlreadyRanError");

      const cancelError = yield* store
        .softDelete({ itemId: created.item.itemId, expectedUpdatedAt: failed!.updatedAt })
        .pipe(Effect.flip);
      assert.equal(cancelError._tag, "NextTurnQueueItemAlreadyRanError");

      const queue = yield* store.listByThread(threadId);
      const clearError = yield* store
        .clear({ threadId, scope: "all", expectedRevision: queue.state.revision })
        .pipe(Effect.flip);
      assert.equal(clearError._tag, "NextTurnQueueItemAlreadyRanError");
      assert.equal((yield* store.getItem(created.item.itemId)) !== null, true);
    }),
  );

  it.effect("sweeps untracked staging files left before attachment metadata commits", () =>
    Effect.gen(function* () {
      const store = yield* NextTurnQueueStore;
      const config = yield* ServerConfig;
      const stagingDirectory = path.join(config.attachmentsDir, ".staging", "crashed-submission");
      const stagingFile = path.join(stagingDirectory, "private-image.png");
      fs.mkdirSync(stagingDirectory, { recursive: true });
      fs.writeFileSync(stagingFile, "private");
      assert.equal(fs.existsSync(stagingFile), true);

      yield* store.drainOrphanedAttachments;
      assert.equal(fs.existsSync(stagingFile), false);
    }),
  );

  it.effect("sweeps ingress files left after finalization but before queue admission", () =>
    Effect.gen(function* () {
      const store = yield* NextTurnQueueStore;
      const config = yield* ServerConfig;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("queue-crashed-ingress-thread");
      yield* seedThread(threadId);
      const attachmentId = "queue-crashed-ingress-00000000-0000-4000-8000-000000000001";
      const finalPath = path.join(config.attachmentsDir, `${attachmentId}.png`);
      const now = new Date().toISOString();
      fs.mkdirSync(config.attachmentsDir, { recursive: true });
      fs.writeFileSync(finalPath, "private");
      yield* sql`
        INSERT INTO attachments (
          attachment_id, thread_id, type, name, mime_type, size_bytes, content_hash,
          staging_path, final_path, lifecycle, created_at, updated_at
        ) VALUES (
          ${attachmentId}, ${threadId}, 'image', 'private.png', 'image/png', 7,
          'private-hash', NULL, ${finalPath}, 'ready', ${now}, ${now}
        )
      `;
      yield* sql`
        INSERT INTO attachment_owners (attachment_id, owner_kind, owner_id, created_at)
        VALUES (${attachmentId}, 'ingress', 'crashed-command', ${now})
      `;

      yield* store.drainOrphanedAttachments;
      assert.equal(fs.existsSync(finalPath), false);
      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM attachments WHERE attachment_id = ${attachmentId}
      `;
      assert.equal(rows[0]?.count ?? -1, 0);
    }),
  );
});
