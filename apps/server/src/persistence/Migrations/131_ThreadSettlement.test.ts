import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqliteClient from "../NodeSqliteClient.ts";
import migration from "./131_ThreadSettlement.ts";

it.effect("repairs missing core tables without requiring historical provenance", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* migration;
      yield* migration;
      const columns = yield* sql<{
        name: string;
      }>`SELECT name FROM pragma_table_info('projection_threads')`;
      assert.isTrue(columns.some((column) => column.name === "settled_at"));
      assert.deepStrictEqual(yield* sql`SELECT * FROM thread_message_authorship`, []);
      assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
    }),
  ).pipe(Effect.provide(SqliteClient.layerMemory())),
);

it.effect(
  "backfills only matched automation evidence and tolerates malformed historical payloads",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE projection_threads(thread_id TEXT PRIMARY KEY,project_id TEXT)`;
        yield* sql`CREATE TABLE projection_thread_messages(message_id TEXT PRIMARY KEY,thread_id TEXT,role TEXT)`;
        yield* sql`CREATE TABLE orchestration_events(command_id TEXT,stream_id TEXT,event_type TEXT,payload_json TEXT)`;
        yield* sql`CREATE TABLE provider_submission_provenance(command_id TEXT PRIMARY KEY,thread_id TEXT,source TEXT)`;
        yield* sql`INSERT INTO projection_threads(thread_id,project_id) VALUES('thread','project')`;
        for (const [id, source, payload] of [
          ["automated", "automation", '{"messageId":"automated"}'],
          ["corrupt", "automation", "invalid-json"],
          ["human", "human", '{"messageId":"human"}'],
        ]) {
          yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role) VALUES(${id},'thread','user')`;
          yield* sql`INSERT INTO provider_submission_provenance(command_id,thread_id,source) VALUES(${id},'thread',${source})`;
          yield* sql`INSERT INTO orchestration_events(command_id,stream_id,event_type,payload_json) VALUES(${id},'thread','thread.message-sent',${payload})`;
        }
        yield* migration;
        yield* migration;
        assert.deepStrictEqual(
          yield* sql`SELECT message_id,source FROM thread_message_authorship`,
          [{ message_id: "automated", source: "automation" }],
        );
        const messages = yield* sql`SELECT message_id FROM projection_thread_messages`;
        assert.lengthOf(messages, 3);
        assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
      }),
    ).pipe(Effect.provide(SqliteClient.layerMemory())),
);
