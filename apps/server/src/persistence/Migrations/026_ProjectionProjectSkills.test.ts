import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration0026 from "./026_ProjectionProjectSkills.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("026_ProjectionProjectSkills", (it) => {
  it.effect("creates projection_project_skills with command-name indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* Migration0026;

      const columns = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM pragma_table_info('projection_project_skills')
        ORDER BY cid ASC
      `;
      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND tbl_name = 'projection_project_skills'
        ORDER BY name ASC
      `;

      assert.deepEqual(
        columns.map((row) => row.name),
        [
          "skill_id",
          "project_id",
          "scope",
          "command_name",
          "display_name",
          "description",
          "argument_hint",
          "allowed_tools_json",
          "paths_json",
          "updated_at",
        ],
      );
      assert.deepEqual(
        indexes.map((row) => row.name),
        [
          "projection_project_skills_project_command_name_idx",
          "projection_project_skills_project_updated_at_idx",
          "sqlite_autoindex_projection_project_skills_1",
        ],
      );
    }),
  );
});
