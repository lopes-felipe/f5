import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Hardened in place for fresh/replayed DBs; 047 repairs DBs that already applied 026.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_project_skills (
      skill_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      command_name TEXT NOT NULL,
      display_name TEXT,
      description TEXT NOT NULL,
      argument_hint TEXT,
      allowed_tools_json TEXT NOT NULL,
      paths_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projection_projects(project_id)
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS projection_project_skills_project_command_name_idx
    ON projection_project_skills (project_id, command_name)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS projection_project_skills_project_updated_at_idx
    ON projection_project_skills (project_id, updated_at DESC)
  `;
});
