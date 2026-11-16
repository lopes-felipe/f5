import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ManagedRuntime } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ORCHESTRATION_PROJECTOR_NAMES } from "../../src/orchestration/Layers/ProjectionPipeline.ts";
import { makeSqlitePersistenceLive } from "../../src/persistence/Layers/Sqlite.ts";
import { compactThreadEvents, MAX_EVENTS_PER_GROUP } from "../../src/storage/eventCompaction.ts";
import { fixture } from "../../../../scripts/lib/performance/fixtures.ts";
import { measure } from "../../../../scripts/lib/performance/report.ts";

/** Largest admitted atomic message group, with an ordinary writer queued at rewrite. */
export async function measureCompaction(filename: string, method: typeof fixture.method) {
  const runtime = ManagedRuntime.make(
    makeSqlitePersistenceLive(filename).pipe(Layer.provide(NodeServices.layer)),
  );
  const sql = await runtime.runPromise(SqlClient.SqlClient.asEffect());
  let maxWriterWaitMs = 0,
    maxTransactionMs = 0;
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('perf','perf','/perf','[]',${fixture.epoch},${fixture.epoch})`;
        yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model,created_at,last_interaction_at,updated_at) VALUES ('perf','perf','perf','gpt-5-codex',${fixture.epoch},${fixture.epoch},${fixture.epoch})`;
        yield* sql`CREATE TABLE perf_compaction_writer(value INTEGER)`;
        for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES))
          yield* sql`INSERT INTO projection_state(projector,last_applied_sequence,updated_at) VALUES (${projector},2147483647,${fixture.epoch})`;
      }),
    );
    // Fixture reset is outside the timed measurement, using measure's preparation hook.
    const reset = () =>
      runtime.runPromise(
        sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`DELETE FROM orchestration_events`;
              yield* sql`DELETE FROM orchestration_event_compaction`;
              yield* sql`WITH RECURSIVE entries(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM entries WHERE n < ${MAX_EVENTS_PER_GROUP})
        INSERT INTO orchestration_events(event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json)
        SELECT 'perf-' || n,'thread','perf',n,'thread.message-sent',${fixture.epoch},'provider',
          json_object('messageId','perf-message','threadId','perf','turnId','perf-turn','role','assistant','text',CASE WHEN n = ${MAX_EVENTS_PER_GROUP} THEN '' ELSE ${"x".repeat(fixture.assistantStream.maxDeltaChars)} END,'streaming',json(CASE WHEN n = ${MAX_EVENTS_PER_GROUP} THEN 'false' ELSE 'true' END),'createdAt',${fixture.epoch}),'{}' FROM entries`;
            }),
          )
          .pipe(Effect.asVoid),
      );
    let writer: Promise<unknown> | undefined;
    let rewriting = false;
    const intercepted = new Proxy(sql, {
      apply(target, self, args) {
        const statement = Reflect.apply(target, self, args);
        if (String(args[0]).includes("UPDATE orchestration_events SET payload_json"))
          return statement.pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (rewriting) return;
                rewriting = true;
                const start = performance.now();
                writer = runtime
                  .runPromise(sql`INSERT INTO perf_compaction_writer(value) VALUES (1)`)
                  .then(() => {
                    maxWriterWaitMs = Math.max(maxWriterWaitMs, performance.now() - start);
                  });
              }),
            ),
          );
        return statement;
      },
      get(target, property, receiver) {
        if (property === "withTransaction")
          return (effect: Effect.Effect<unknown>) =>
            Effect.suspend(() => {
              const start = performance.now();
              return target.withTransaction(effect).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    maxTransactionMs = Math.max(maxTransactionMs, performance.now() - start);
                  }),
                ),
              );
            });
        return Reflect.get(target, property, receiver);
      },
    });
    const samples = await measure(
      async () => {
        rewriting = false;
        const result = await runtime.runPromise(
          compactThreadEvents({ nowMs: Date.now(), maxDurationMs: 60_000 }).pipe(
            Effect.provideService(SqlClient.SqlClient, intercepted),
          ),
        );
        await writer;
        if (result.eventsRemoved !== MAX_EVENTS_PER_GROUP - 1 || result.messagesCompacted !== 1)
          throw new Error("Compaction fixture did not commit one complete group");
      },
      method,
      reset,
    );
    return {
      samples,
      diagnostics: {
        maxWriterWaitMs,
        maxTransactionMs,
        groupEvents: MAX_EVENTS_PER_GROUP,
        deltaCharacters: fixture.assistantStream.maxDeltaChars,
      },
    };
  } finally {
    await runtime.dispose();
  }
}
