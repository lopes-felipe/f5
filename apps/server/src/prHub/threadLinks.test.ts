import { ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqlite from "../persistence/NodeSqliteClient.ts";
import { readThreadPullRequestLinks, threadTitlePullRequestContext } from "./threadLinks.ts";

const threadId = ThreadId.makeUnsafe("title-thread");
const database = NodeSqlite.layer({ filename: ":memory:" });
const create = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE projection_thread_pull_requests (
    link_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, provider TEXT, host TEXT,
    repository TEXT, number INTEGER, title TEXT, url TEXT, updated_at TEXT
  )`;
  return sql;
});

it.layer(NodeServices.layer)("local thread PR context", (it) => {
  it.effect("selects recent links for exactly one thread with separate UI and title limits", () =>
    Effect.gen(function* () {
      const sql = yield* create;
      for (let i = 0; i < 55; i++) {
        yield* sql`INSERT INTO projection_thread_pull_requests VALUES (${String(i)},${threadId},'github','github.com','team/repo',${i + 1},${`PR ${i}`},'https://github.com/team/repo/pull/1',${String(i).padStart(3, "0")})`;
      }
      yield* sql`INSERT INTO projection_thread_pull_requests VALUES ('other','other-thread','github','github.com','team/other',1,'PRIVATE_OTHER_THREAD','https://github.com/team/other/pull/1','999')`;
      const all = yield* readThreadPullRequestLinks(threadId);
      const title = yield* readThreadPullRequestLinks(threadId, 5);
      assert.lengthOf(all, 50);
      assert.deepEqual(
        title.map((link) => link.title),
        ["PR 54", "PR 53", "PR 52", "PR 51", "PR 50"],
      );
      assert.notInclude(JSON.stringify(all), "PRIVATE_OTHER_THREAD");
      const context = threadTitlePullRequestContext(all);
      assert.equal(JSON.parse(context!).length, 5);
      assert.notInclude(context!, '"url"');
      assert.isUndefined(threadTitlePullRequestContext([]));
    }).pipe(Effect.provide(database)),
  );

  for (const invalid of ["title", "url", "number"] as const) {
    it.effect(`rejects an invalid persisted ${invalid} before it becomes prompt context`, () =>
      Effect.gen(function* () {
        const sql = yield* create;
        yield* sql`INSERT INTO projection_thread_pull_requests VALUES ('bad',${threadId},'github','github.com','team/repo',${invalid === "number" ? -1 : 1},${invalid === "title" ? "" : "Review transport"},${invalid === "url" ? "file:///private" : "https://github.com/team/repo/pull/1"},'001')`;
        const result = yield* readThreadPullRequestLinks(threadId, 5).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.equal(result.failure._tag, "SchemaError");
      }).pipe(Effect.provide(database)),
    );
  }

  it.effect("bounds reference labels before serializing title context", () =>
    Effect.gen(function* () {
      const sql = yield* create;
      yield* sql`INSERT INTO projection_thread_pull_requests VALUES ('long',${threadId},'github',${"h".repeat(20_000)},${"r".repeat(20_000)},1,'Review transport','https://github.com/team/repo/pull/1','001')`;
      const context = threadTitlePullRequestContext(yield* readThreadPullRequestLinks(threadId, 5));
      assert.isAtMost(context!.length, 1_500);
    }).pipe(Effect.provide(database)),
  );
});
