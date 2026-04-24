import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const existing = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name = 'projection_project_skills'
  `;

  if (existing.length > 0) {
    return;
  }

  yield* sql`
    CREATE TABLE projection_project_skills (
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
    CREATE UNIQUE INDEX projection_project_skills_project_command_name_idx
    ON projection_project_skills (project_id, command_name)
  `;

  yield* sql`
    CREATE INDEX projection_project_skills_project_updated_at_idx
    ON projection_project_skills (project_id, updated_at DESC)
  `;
});
