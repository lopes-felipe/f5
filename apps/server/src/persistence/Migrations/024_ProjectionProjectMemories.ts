import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Hardened in place for fresh/replayed DBs; 047 repairs DBs that already applied 024.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_project_memories (
      memory_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      FOREIGN KEY (project_id) REFERENCES projection_projects(project_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS projection_project_memories_project_id_idx
    ON projection_project_memories (project_id, deleted_at, updated_at DESC)
  `;
});
