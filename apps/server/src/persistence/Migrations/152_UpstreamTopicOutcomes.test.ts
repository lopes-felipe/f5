import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration152 from "./152_UpstreamTopicOutcomes.ts";

it.layer(SqliteClient.layerMemory())("152_UpstreamTopicOutcomes", (it) => {
  it.effect(
    "repairs invalid pointers without changing valid replies or borrowing text from another turn",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE projection_turns
        (thread_id TEXT,turn_id TEXT,assistant_message_id TEXT)`;
        yield* sql`CREATE TABLE projection_thread_messages
        (message_id TEXT,thread_id TEXT,turn_id TEXT,role TEXT,is_streaming INTEGER,text TEXT,created_at TEXT)`;
        yield* sql`INSERT INTO projection_turns VALUES
        ('a','turn','assistant:toolu_missing'), ('a','valid','valid-reply'),
        ('a','missing','foreign-reply'), ('empty','turn',NULL)`;
        yield* sql`INSERT INTO projection_thread_messages VALUES
        ('old','a','turn','assistant',0,'Commentary','1'),
        ('final','a','turn','assistant',0,'Outcome','2'),
        ('reasoning','a','turn','assistant',0,'','3'),
        ('unfinished','a','turn','assistant',1,'Partial','4'),
        ('valid-reply','a','valid','assistant',0,'Valid','1'),
        ('foreign-reply','b','missing','assistant',0,'Foreign','1')`;
        yield* Migration152;
        assert.deepStrictEqual(
          yield* sql`SELECT assistant_message_id FROM projection_turns ORDER BY rowid`,
          [
            { assistant_message_id: "final" },
            { assistant_message_id: "valid-reply" },
            { assistant_message_id: "foreign-reply" },
            { assistant_message_id: null },
          ],
        );
        assert.lengthOf(yield* sql`SELECT * FROM upstream_port_topic_outcomes`, 0);
      }),
  );
});
