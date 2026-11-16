import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect } from "vitest";
import { ThreadId } from "@t3tools/contracts";
import {
  WorkspaceTransitions,
  type WorkspaceTransitionRecord,
} from "../Services/WorkspaceTransitions.ts";
import { makeWorkspaceTransitions, WorkspaceTransitionsLive } from "./WorkspaceTransitions.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const record = (id: string, threadId = ThreadId.makeUnsafe(id)): WorkspaceTransitionRecord => ({
  operationId: id,
  threadId,
  requestHash: id,
  version: 0,
  intent: "attach_existing",
  phase: "reserved",
  request: {
    operationId: id,
    threadId,
    intent: "attach_existing",
    expected: { branch: "main", worktreePath: null, sessionUpdatedAt: null },
  },
  source: { path: "/repo", repository: "/repo/.git", branch: "main", headSha: "a" },
  target: { path: "/worktrees/target", repository: "/repo/.git", branch: "topic", headSha: "b" },
  observed: null,
  fingerprint: null,
  mutationAttempted: false,
  result: null,
  error: null,
  setupOwnerToken: null,
  commandId: `workspace:${id}`,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});
const seed = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model,model_selection_json,branch,created_at,last_interaction_at,updated_at) VALUES (${id},'project','Thread','test-model','{}','main','now','now','now')`;
  });
it.layer(WorkspaceTransitionsLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)))(
  "durable workspace transitions",
  (it) => {
    it.effect(
      "replays identical requests, rejects changed IDs and serializes competing clients",
      () =>
        Effect.gen(function* () {
          const store = yield* WorkspaceTransitions;
          yield* seed("clients");
          const first = record("first", ThreadId.makeUnsafe("clients"));
          const second = record("second", first.threadId);
          const results = yield* Effect.all(
            [store.reserve(first).pipe(Effect.exit), store.reserve(second).pipe(Effect.exit)],
            { concurrency: 2 },
          );
          expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
          const winner = (yield* store.forThread(first.threadId, true))!;
          expect(yield* store.reserve(winner)).toEqual(winner);
          expect(
            (yield* store.reserve({ ...winner, requestHash: "changed" }).pipe(Effect.exit))._tag,
          ).toBe("Failure");
          expect(
            (yield* store
              .update({ ...winner, version: 100 }, { phase: "completed" })
              .pipe(Effect.exit))._tag,
          ).toBe("Failure");
        }),
    );
    for (const phase of [
      "reserved",
      "stopping",
      "applying",
      "applied",
      "needs_recovery",
    ] as const) {
      it.effect(`restart at ${phase} retains the barrier without repeating Git`, () =>
        Effect.gen(function* () {
          const store = yield* WorkspaceTransitions;
          yield* seed(phase);
          const initial = yield* store.reserve(record(phase));
          yield* store.update(initial, {
            phase,
            mutationAttempted: phase === "applying" || phase === "applied",
          });
          const restarted = yield* makeWorkspaceTransitions;
          yield* restarted.reconcile;
          const recovered = yield* restarted.forThread(initial.threadId, true);
          expect(recovered?.phase).toBe("needs_recovery");
          expect(recovered?.source).toEqual(initial.source);
          expect(
            (yield* restarted.reserve(record(`other-${phase}`, initial.threadId)).pipe(Effect.exit))
              ._tag,
          ).toBe("Failure");
          yield* restarted.cancel(initial.threadId);
          expect(yield* restarted.forThread(initial.threadId, true)).toBeNull();
          expect((yield* restarted.get(initial.operationId))?.phase).toBe("cancelled");
        }),
      );
    }
    it.effect("blocks queued work and pending turns at atomic reservation", () =>
      Effect.gen(function* () {
        const store = yield* WorkspaceTransitions;
        const sql = yield* SqlClient.SqlClient;
        yield* seed("pending");
        yield* sql`INSERT INTO projection_turns(thread_id,state,requested_at,checkpoint_files_json) VALUES ('pending','pending','now','[]')`;
        expect((yield* store.reserve(record("pending")).pipe(Effect.exit))._tag).toBe("Failure");
      }),
    );
    it.effect("manual queue resume never releases the independent barrier", () =>
      Effect.gen(function* () {
        const store = yield* WorkspaceTransitions;
        const sql = yield* SqlClient.SqlClient;
        yield* seed("pause");
        const active = yield* store.reserve(record("pause"));
        yield* sql`INSERT INTO next_turn_queue_state(thread_id,paused,pause_reason_code,revision,updated_at) VALUES ('pause',1,'manual_pause',1,'now')`;
        yield* sql`UPDATE next_turn_queue_state SET paused=0, pause_reason_code=NULL, revision=revision+1 WHERE thread_id='pause'`;
        expect(yield* store.forThread(active.threadId, true)).toEqual(active);
      }),
    );
    it.effect(
      "finalizes a committed metadata receipt without repeating Git, including a null project-checkout path",
      () =>
        Effect.gen(function* () {
          const store = yield* WorkspaceTransitions;
          const sql = yield* SqlClient.SqlClient;
          yield* seed("committed");
          const initial = yield* store.reserve(record("committed"));
          yield* store.update(initial, {
            phase: "applied",
            result: { branch: "topic", worktreePath: null, sessionUpdatedAt: null },
          });
          yield* sql`UPDATE projection_threads SET branch='topic',worktree_path=NULL WHERE thread_id='committed'`;
          yield* sql`INSERT INTO orchestration_command_receipts(command_id,aggregate_kind,aggregate_id,accepted_at,result_sequence,status,error) VALUES (${initial.commandId},'thread','committed','now',1,'accepted',NULL)`;
          const restarted = yield* makeWorkspaceTransitions;
          yield* restarted.reconcile;
          expect((yield* restarted.get(initial.operationId))?.phase).toBe("completed");
          expect(yield* restarted.forThread(initial.threadId, true)).toBeNull();
        }),
    );
    it.effect("returns a reactivated older operation ahead of newer failed history", () =>
      Effect.gen(function* () {
        const store = yield* WorkspaceTransitions;
        yield* seed("retry-history");
        const threadId = ThreadId.makeUnsafe("retry-history");
        const a = yield* store.update(
          yield* store.reserve({ ...record("history-a", threadId), createdAt: "2026-01-01" }),
          { phase: "failed" },
        );
        yield* store.update(
          yield* store.reserve({ ...record("history-b", threadId), createdAt: "2026-01-02" }),
          { phase: "failed" },
        );
        expect((yield* store.forThread(threadId))?.operationId).toBe("history-b");
        const retried = yield* store.reactivate(a);
        expect(yield* store.forThread(threadId)).toEqual(retried);
        const recovery = yield* store.update(retried, { phase: "needs_recovery" });
        expect(yield* store.forThread(threadId)).toEqual(recovery);
      }),
    );
    it.effect("uses the partial recovery index instead of scanning completed move manifests", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const plan = yield* sql<{
          detail: string;
        }>`EXPLAIN QUERY PLAN SELECT record_json AS record,phase,version FROM workspace_transitions WHERE json_extract(record_json,'$.intent')='move_to_new_worktree' AND (phase IN ('reserved','stopping','applying','applied','needs_recovery') OR json_extract(record_json,'$.moveData.snapshotRef') IS NOT NULL)`;
        expect(
          plan.some((entry) => entry.detail.includes("workspace_transitions_move_recovery")),
        ).toBe(true);
      }),
    );
    it.effect("rechecks pending work before retrying a confirmed pre-mutation failure", () =>
      Effect.gen(function* () {
        const store = yield* WorkspaceTransitions;
        const sql = yield* SqlClient.SqlClient;
        yield* seed("retry-preconditions");
        const failed = yield* store.update(yield* store.reserve(record("retry-preconditions")), {
          phase: "failed",
        });
        yield* sql`INSERT INTO projection_turns(thread_id,state,requested_at,checkpoint_files_json) VALUES ('retry-preconditions','pending','now','[]')`;
        expect((yield* store.reactivate(failed).pipe(Effect.exit))._tag).toBe("Failure");
        expect((yield* store.get(failed.operationId))?.phase).toBe("failed");
      }),
    );
  },
);
