import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import { Schema } from "effect";

const TableInfoRow = Schema.Struct({
  name: Schema.String,
});

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const readColumns = SqlSchema.findAll({
    Request: Schema.Void,
    Result: TableInfoRow,
    execute: () => sql`PRAGMA table_info(projection_thread_messages)`,
  });
  const columns = new Set((yield* readColumns(undefined)).map((column) => column.name));

  if (!columns.has("reasoning_tokens")) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN reasoning_tokens INTEGER
    `;
  }
  if (!columns.has("reasoning_tokens_estimated")) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN reasoning_tokens_estimated INTEGER
    `;
  }
});
