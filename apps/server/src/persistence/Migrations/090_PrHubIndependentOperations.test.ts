import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration084 from "./084_PrHubOperations.ts";
import Migration090 from "./090_PrHubIndependentOperations.ts";

/**
 * The layer is shared across tests, so a previous run of migration 090 would leave its
 * indexes in place and reject the pre-migration rows these tests need to insert.
 * Dropping the table clears its indexes and restores a true pre-090 state.
 * Note draft_version is NOT NULL until 090 relaxes it, so seeded rows must supply one.
 */
const seed = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`DROP TABLE IF EXISTS pr_hub_operations`;
    yield* sql`DROP TABLE IF EXISTS pr_hub_operations_next`;
    yield* Migration084;
  });

const insert = (
  sql: SqlClient.SqlClient,
  row: {
    operationId: string;
    kind: string;
    status: string;
    number: number;
    createdAt: string;
    viewerId?: string;
  },
) =>
  sql`INSERT INTO pr_hub_operations
    (provider_kind, host, viewer_id, repo, number, operation_id, kind, status,
     payload_hash, payload_json, draft_version, correlation_nonce, remote_id,
     error_message, created_at, updated_at)
   VALUES ('github', 'github.com', ${row.viewerId ?? "1"}, 'org/repo', ${row.number},
     ${row.operationId}, ${row.kind}, ${row.status}, 'hash', '{}', 0, ${row.operationId},
     NULL, NULL, ${row.createdAt}, ${row.createdAt})`;

it.layer(SqliteClient.layerMemory())("090_PrHubIndependentOperations", (it) => {
  it.effect("copies every column by name and preserves nullable draft linkage", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed(sql);
      yield* sql`INSERT INTO pr_hub_operations
        (provider_kind, host, viewer_id, repo, number, operation_id, kind, status,
         payload_hash, payload_json, draft_version, correlation_nonce, remote_id,
         error_message, created_at, updated_at)
       VALUES ('github', 'github.com', '1', 'org/repo', 3, 'kept', 'review', 'created',
         'the-hash', '{"a":1}', 7, 'the-nonce', 'remote-9', 'boom', 'created-at', 'updated-at')`;
      yield* Migration090;
      const rows = yield* sql<Record<string, unknown>>`SELECT * FROM pr_hub_operations`;
      assert.equal(rows.length, 1);
      // Every value must land in its own column, not merely in the right position.
      assert.deepStrictEqual(rows[0], {
        provider_kind: "github",
        host: "github.com",
        viewer_id: "1",
        repo: "org/repo",
        number: 3,
        operation_id: "kept",
        kind: "review",
        status: "created",
        payload_hash: "the-hash",
        payload_json: '{"a":1}',
        draft_version: 7,
        correlation_nonce: "the-nonce",
        remote_id: "remote-9",
        error_message: "boom",
        created_at: "created-at",
        updated_at: "updated-at",
      });
      // The relaxed column is what migration 090 exists for.
      yield* sql`INSERT INTO pr_hub_operations
        (provider_kind, host, viewer_id, repo, number, operation_id, kind, status,
         payload_hash, payload_json, draft_version, correlation_nonce, created_at, updated_at)
       VALUES ('github', 'github.com', '1', 'org/repo', 4, 'quick', 'review', 'prepared',
         'h', '{}', NULL, 'n', 'c', 'u')`;
    }),
  );

  it.effect("retires superseded active comment operations so the unique index can build", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed(sql);
      // Three active comment operations on one PR: only the newest may survive.
      yield* insert(sql, {
        operationId: "old",
        kind: "comment",
        status: "creating",
        number: 5,
        createdAt: "2024-01-01T00:00:00.000Z",
      });
      yield* insert(sql, {
        operationId: "mid",
        kind: "comment",
        status: "prepared",
        number: 5,
        createdAt: "2024-01-02T00:00:00.000Z",
      });
      yield* insert(sql, {
        operationId: "new",
        kind: "comment",
        status: "outcome_unknown",
        number: 5,
        createdAt: "2024-01-03T00:00:00.000Z",
      });
      // A different PR and a different account are separate groups and stay untouched.
      yield* insert(sql, {
        operationId: "other-pr",
        kind: "comment",
        status: "prepared",
        number: 6,
        createdAt: "2024-01-01T00:00:00.000Z",
      });
      yield* insert(sql, {
        operationId: "other-viewer",
        kind: "comment",
        status: "prepared",
        number: 5,
        createdAt: "2024-01-01T00:00:00.000Z",
        viewerId: "2",
      });
      // Already-settled rows are outside the partial index and must not be rewritten.
      yield* insert(sql, {
        operationId: "settled",
        kind: "comment",
        status: "succeeded",
        number: 5,
        createdAt: "2024-01-04T00:00:00.000Z",
      });

      yield* Migration090;

      const rows = yield* sql<{ operation_id: string; status: string }>`
        SELECT operation_id, status FROM pr_hub_operations ORDER BY operation_id`;
      assert.deepStrictEqual(
        rows.map((row) => `${row.operation_id}:${row.status}`),
        [
          "mid:abandoned",
          "new:outcome_unknown",
          "old:abandoned",
          "other-pr:prepared",
          "other-viewer:prepared",
          "settled:succeeded",
        ],
      );
      // The index now exists, so a second active comment on PR 5 is rejected outright.
      const clash = yield* Effect.exit(
        insert(sql, {
          operationId: "clash",
          kind: "comment",
          status: "prepared",
          number: 5,
          createdAt: "2024-01-05T00:00:00.000Z",
        }),
      );
      assert.equal(clash._tag, "Failure");
    }),
  );

  it.effect("breaks created_at ties deterministically instead of retiring both rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed(sql);
      for (const operationId of ["aaa", "zzz"])
        yield* insert(sql, {
          operationId,
          kind: "comment",
          status: "prepared",
          number: 9,
          createdAt: "2024-05-05T00:00:00.000Z",
        });
      yield* Migration090;
      const survivors = yield* sql<{ operation_id: string }>`
        SELECT operation_id FROM pr_hub_operations
        WHERE status IN ('prepared', 'creating', 'outcome_unknown')`;
      assert.deepStrictEqual(
        survivors.map((row) => row.operation_id),
        ["zzz"],
      );
    }),
  );
});
