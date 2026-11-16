import { randomUUID } from "node:crypto";
import { PullRequestKey, ThreadId, ThreadPullRequestWatch } from "@t3tools/contracts";
import { Data, Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export class PullRequestWatchError extends Data.TaggedError("PullRequestWatchError")<{
  readonly message: string;
}> {}
export interface PullRequestWatchRow {
  readonly threadId: ThreadId;
  readonly key: PullRequestKey;
  readonly accountId: string;
  readonly watchId: string;
  readonly watch: ThreadPullRequestWatch;
  readonly version: number;
  readonly readFailures: number;
  readonly nextAttemptAt: string | null;
}
interface RawRow {
  thread_id: string;
  pr_key: string;
  account_id: string;
  watch_id: string;
  watch_json: string;
  version: number;
  read_failures: number;
  next_attempt_at: string | null;
}

export const makePullRequestWatchStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const db = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.mapError((error) =>
        error instanceof PullRequestWatchError
          ? error
          : new PullRequestWatchError({ message: "PR watch storage is unavailable." }),
      ),
    );
  const decode = (row: RawRow): PullRequestWatchRow => ({
    threadId: ThreadId.makeUnsafe(row.thread_id),
    key: PullRequestKey.makeUnsafe(row.pr_key),
    accountId: row.account_id,
    watchId: row.watch_id,
    watch: Schema.decodeUnknownSync(ThreadPullRequestWatch)(JSON.parse(row.watch_json)),
    version: row.version,
    readFailures: row.read_failures,
    nextAttemptAt: row.next_attempt_at,
  });
  const rows = (
    query: Effect.Effect<ReadonlyArray<RawRow>, import("effect/unstable/sql/SqlError").SqlError>,
  ) =>
    db(query).pipe(
      Effect.flatMap((values) =>
        Effect.try({
          try: () => values.map(decode),
          catch: () =>
            new PullRequestWatchError({
              message: "A saved PR watch is invalid. Stop and restart it.",
            }),
        }),
      ),
    );
  const get = (threadId: ThreadId, key: PullRequestKey) =>
    rows(
      sql<RawRow>`SELECT * FROM thread_pull_request_watches WHERE thread_id=${threadId} AND pr_key=${key}`,
    ).pipe(Effect.map((values) => values[0] ?? null));
  const list = (threadId: ThreadId) =>
    rows(
      sql<RawRow>`SELECT * FROM thread_pull_request_watches WHERE thread_id=${threadId} ORDER BY updated_at DESC LIMIT 20`,
    );
  const due = (now: string) =>
    rows(
      sql<RawRow>`SELECT * FROM thread_pull_request_watches WHERE next_attempt_at IS NULL OR next_attempt_at<=${now} ORDER BY updated_at ASC LIMIT 1000`,
    );
  const stopGeneration = (threadId: ThreadId) =>
    db(
      sql<{
        generation: number;
      }>`SELECT generation FROM thread_pull_request_watch_stops WHERE thread_id=${threadId}`,
    ).pipe(Effect.map((rows) => rows[0]?.generation ?? 0));
  const start = (input: {
    threadId: ThreadId;
    key: PullRequestKey;
    accountId: string;
    expectedStopGeneration?: number;
    watch: ThreadPullRequestWatch;
  }) =>
    db(
      sql.withTransaction(
        Effect.gen(function* () {
          if (
            input.expectedStopGeneration !== undefined &&
            (yield* stopGeneration(input.threadId)) !== input.expectedStopGeneration
          )
            return yield* new PullRequestWatchError({
              message: "This watch was stopped while it was starting. Start it again to retry.",
            });
          const existing = yield* get(input.threadId, input.key);
          if (existing) return existing;
          const count = yield* sql<{
            total: number;
            perThread: number;
          }>`SELECT count(*) AS total,coalesce(sum(thread_id=${input.threadId}),0) AS perThread FROM thread_pull_request_watches`;
          if ((count[0]?.total ?? 0) >= 1000 || (count[0]?.perThread ?? 0) >= 20)
            return yield* new PullRequestWatchError({
              message: "The PR watch limit has been reached.",
            });
          const watchId = randomUUID();
          const inserted =
            yield* sql`INSERT INTO thread_pull_request_watches(thread_id,pr_key,account_id,watch_id,watch_json,updated_at) SELECT ${input.threadId},${input.key},${input.accountId},${watchId},${JSON.stringify(input.watch)},${input.watch.startedAt} FROM projection_threads WHERE thread_id=${input.threadId} AND archived_at IS NULL AND deleted_at IS NULL AND settled_at IS NULL RETURNING watch_id`;
          if (!inserted.length)
            return yield* new PullRequestWatchError({
              message: "This thread is no longer active.",
            });
          return { ...input, watchId, version: 0, readFailures: 0, nextAttemptAt: null };
        }),
      ),
    );
  const replace = (
    row: PullRequestWatchRow,
    watch: ThreadPullRequestWatch,
    now: string,
    nextAttemptAt: string | null = null,
  ) =>
    db(
      sql`UPDATE thread_pull_request_watches SET watch_json=${JSON.stringify(watch)},version=version+1,read_failures=0,next_attempt_at=${nextAttemptAt},updated_at=${now} WHERE thread_id=${row.threadId} AND pr_key=${row.key} AND watch_id=${row.watchId} AND version=${row.version} RETURNING watch_id`,
    ).pipe(Effect.map((values) => values.length > 0));
  const failure = (
    row: PullRequestWatchRow,
    now: string,
    nextAttemptAt: string,
    rateLimited: boolean,
  ) =>
    db(
      sql`UPDATE thread_pull_request_watches SET version=version+1,read_failures=min(8,read_failures+${rateLimited ? 0 : 1}),next_attempt_at=${nextAttemptAt},updated_at=${now} WHERE thread_id=${row.threadId} AND pr_key=${row.key} AND watch_id=${row.watchId} AND version=${row.version}`,
    );
  const stop = (threadId: ThreadId, key?: PullRequestKey) =>
    db(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO thread_pull_request_watch_stops(thread_id,generation) SELECT thread_id,1 FROM projection_threads WHERE thread_id=${threadId} ON CONFLICT(thread_id) DO UPDATE SET generation=generation+1`;
          const stopped = yield* key
            ? sql<{
                watch_id: string;
              }>`DELETE FROM thread_pull_request_watches WHERE thread_id=${threadId} AND pr_key=${key} RETURNING watch_id`
            : sql<{
                watch_id: string;
              }>`DELETE FROM thread_pull_request_watches WHERE thread_id=${threadId} RETURNING watch_id`;
          return stopped.map((row) => row.watch_id);
        }),
      ),
    );
  const stopExpected = (row: PullRequestWatchRow) =>
    db(
      sql`DELETE FROM thread_pull_request_watches WHERE thread_id=${row.threadId} AND pr_key=${row.key} AND watch_id=${row.watchId} AND version=${row.version} RETURNING watch_id`,
    ).pipe(Effect.map((values) => values.length > 0));
  return { get, list, due, start, replace, failure, stop, stopExpected, stopGeneration };
});
