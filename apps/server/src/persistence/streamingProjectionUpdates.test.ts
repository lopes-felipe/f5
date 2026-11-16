import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ThreadId, TurnId, MessageId, type OrchestrationEvent } from "@t3tools/contracts";
import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import { makeStreamingProjectionUpdates } from "./streamingProjectionUpdates.ts";

type MessageEvent = Extract<OrchestrationEvent, { type: "thread.message-sent" }>;
const event = {
  type: "thread.message-sent",
  occurredAt: "2026-10-19T12:00:01.000Z",
  payload: {
    threadId: ThreadId.makeUnsafe("streaming-thread"),
    messageId: MessageId.makeUnsafe("streaming-message"),
    turnId: TurnId.makeUnsafe("streaming-turn"),
    role: "assistant",
    text: "😀",
    reasoningText: "reason",
    streaming: true,
    createdAt: "2026-10-19T12:00:00.000Z",
    updatedAt: "2026-10-19T12:00:01.000Z",
  },
} as MessageEvent;

it.layer(SqlitePersistenceMemory)("streaming projection SQL", (it) => {
  // Temporary tables isolate this seam's exact UPDATE behavior from migration defaults.
  const setup = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TEMP TABLE IF NOT EXISTS projection_threads (thread_id TEXT PRIMARY KEY, estimated_context_tokens INTEGER, last_interaction_at TEXT, updated_at TEXT, untouched TEXT)`;
    yield* sql`CREATE TEMP TABLE IF NOT EXISTS projection_thread_sessions (thread_id TEXT PRIMARY KEY, estimated_context_tokens INTEGER, token_usage_source TEXT, updated_at TEXT, untouched TEXT)`;
    yield* sql`CREATE TEMP TABLE IF NOT EXISTS projection_turns (thread_id TEXT, turn_id TEXT, assistant_message_id TEXT, state TEXT, started_at TEXT, requested_at TEXT, completed_at TEXT, untouched TEXT)`;
    yield* sql`DELETE FROM projection_threads`;
    yield* sql`DELETE FROM projection_thread_sessions`;
    yield* sql`DELETE FROM projection_turns`;
    return { sql, updates: makeStreamingProjectionUpdates(sql) };
  });
  it.effect(
    "uses delta lengths, preserves provider estimates, and falls back for unknown totals",
    () =>
      Effect.gen(function* () {
        const { sql, updates } = yield* setup;
        for (const source of [null, "estimated", "provider"] as const)
          for (const threadTokens of [null, 0, 40])
            for (const sessionTokens of [null, 0, 50]) {
              yield* sql`DELETE FROM projection_threads`;
              yield* sql`DELETE FROM projection_thread_sessions`;
              yield* sql`INSERT INTO projection_threads VALUES (${event.payload.threadId}, ${threadTokens}, 'old', 'old', 'keep')`;
              yield* sql`INSERT INTO projection_thread_sessions VALUES (${event.payload.threadId}, ${sessionTokens}, ${source}, 'old', 'keep')`;
              // Session runs before thread, exactly as the production projector order.
              const sessionUpdated = yield* updates.session(event);
              const threadUpdated = yield* updates.thread(event);
              const expectedSession =
                source === "provider"
                  ? sessionTokens
                  : (sessionTokens ?? threadTokens) === null
                    ? null
                    : (sessionTokens ?? threadTokens)! + 2;
              assert.equal(sessionUpdated, source === "provider" || expectedSession !== null);
              assert.equal(threadUpdated, source === "provider" || threadTokens !== null);
              const threads =
                yield* sql`SELECT estimated_context_tokens AS tokens, untouched FROM projection_threads`;
              const sessions =
                yield* sql`SELECT estimated_context_tokens AS tokens, token_usage_source AS source, untouched FROM projection_thread_sessions`;
              assert.deepEqual(threads, [
                {
                  tokens:
                    source === "provider" || threadTokens === null
                      ? threadTokens
                      : threadTokens + 2,
                  untouched: "keep",
                },
              ]);
              assert.deepEqual(sessions, [
                {
                  tokens: expectedSession,
                  source: sessionUpdated && source !== "provider" ? "estimated" : source,
                  untouched: "keep",
                },
              ]);
            }
        yield* sql`DELETE FROM projection_threads`;
        yield* sql`DELETE FROM projection_thread_sessions`;
        assert.isFalse(yield* updates.thread(event));
        assert.isFalse(yield* updates.session(event));
      }),
  );
  it.effect(
    "retains terminal state and timestamps, fences identity, and rolls all updates back",
    () =>
      Effect.gen(function* () {
        const { sql, updates } = yield* setup;
        for (const state of ["running", "completed", "interrupted", "error"]) {
          yield* sql`DELETE FROM projection_turns`;
          yield* sql`INSERT INTO projection_turns VALUES (${event.payload.threadId}, ${event.payload.turnId}, 'old-message', ${state}, NULL, NULL, 'terminal-time', 'keep')`;
          yield* sql`INSERT INTO projection_turns VALUES ('different-thread', ${event.payload.turnId}, 'unrelated', 'running', NULL, NULL, NULL, 'keep')`;
          assert.isTrue(yield* updates.turn(event));
          assert.isTrue(yield* updates.turn(event));
          const rows =
            yield* sql`SELECT assistant_message_id AS message, state, started_at AS started, requested_at AS requested, completed_at AS completed, untouched FROM projection_turns WHERE thread_id = ${event.payload.threadId}`;
          assert.deepEqual(rows, [
            {
              message: event.payload.messageId,
              state,
              started: event.payload.createdAt,
              requested: event.payload.createdAt,
              completed: "terminal-time",
              untouched: "keep",
            },
          ]);
          assert.equal(
            (yield* sql`SELECT assistant_message_id AS message FROM projection_turns WHERE thread_id = 'different-thread'`)[0]
              ?.message,
            "unrelated",
          );
        }
        yield* sql`INSERT INTO projection_threads VALUES (${event.payload.threadId}, 40, 'old', 'old', 'keep')`;
        yield* sql`INSERT INTO projection_thread_sessions VALUES (${event.payload.threadId}, 50, 'estimated', 'old', 'keep')`;
        const before = yield* sql`SELECT * FROM projection_threads`;
        const result = yield* Effect.result(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* updates.session(event);
              yield* updates.thread(event);
              yield* updates.turn(event);
              return yield* Effect.fail("interrupted after projection writes");
            }),
          ),
        );
        assert.equal(result._tag, "Failure");
        assert.deepEqual(yield* sql`SELECT * FROM projection_threads`, before);
        assert.equal(
          (yield* sql`SELECT estimated_context_tokens AS tokens FROM projection_thread_sessions`)[0]
            ?.tokens,
          50,
        );
      }),
  );
});
