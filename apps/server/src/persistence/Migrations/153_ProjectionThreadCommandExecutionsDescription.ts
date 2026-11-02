import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import { Schema } from "effect";

import RepairProjectionThreadCommandExecutionsSchema from "./044_ProjectionThreadCommandExecutionsSchemaRepair.ts";

const TableInfoRow = Schema.Struct({
  name: Schema.String,
});

export default Effect.gen(function* () {
  // Recreates the table if an earlier run lost it, so the column is never skipped.
  yield* RepairProjectionThreadCommandExecutionsSchema;
  const sql = yield* SqlClient.SqlClient;
  const readColumns = SqlSchema.findAll({
    Request: Schema.Void,
    Result: TableInfoRow,
    execute: () => sql`PRAGMA table_info(projection_thread_command_executions)`,
  });
  const columns = new Set((yield* readColumns(undefined)).map((column) => column.name));

  if (!columns.has("description")) {
    yield* sql`
      ALTER TABLE projection_thread_command_executions
      ADD COLUMN description TEXT
    `;
  }
});
