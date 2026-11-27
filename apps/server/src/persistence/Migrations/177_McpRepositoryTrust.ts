import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Approvals of servers from a project's `.mcp.json`. An approval covers one exact
 * definition: a changed definition has a new hash and needs approval again.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS mcp_repository_trust (
    project_id TEXT NOT NULL,
    server_name TEXT NOT NULL,
    definition_hash TEXT NOT NULL,
    approved_at TEXT NOT NULL,
    PRIMARY KEY(project_id, server_name)
  )`;
});
