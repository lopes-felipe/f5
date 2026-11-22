import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Expired-login failures stay on the session so the thread can offer sign-in and resend. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql.unsafe<{ name: string }>(
    "SELECT name FROM pragma_table_info('projection_thread_sessions')",
  );
  if (columns.length && !columns.some((column) => column.name === "auth_failure_json"))
    yield* sql.unsafe("ALTER TABLE projection_thread_sessions ADD COLUMN auth_failure_json TEXT");
});
