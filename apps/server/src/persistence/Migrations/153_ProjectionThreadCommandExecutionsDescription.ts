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
    execute: () => sql`PRAGMA table_info(projection_thread_command_executions)`,
  });
  const columns = new Set((yield* readColumns(undefined)).map((column) => column.name));

  // No columns means no table: the projection schema repairs create it with the
  // pre-description shape, so only an existing table needs the column added here.
  if (columns.size > 0 && !columns.has("description")) {
    yield* sql`
      ALTER TABLE projection_thread_command_executions
      ADD COLUMN description TEXT
    `;
  }
});
