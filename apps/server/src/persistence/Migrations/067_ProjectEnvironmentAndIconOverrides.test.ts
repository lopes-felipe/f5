import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration0067 from "./067_ProjectEnvironmentAndIconOverrides.ts";

it.layer(SqliteClient.layerMemory())("067_ProjectEnvironmentAndIconOverrides", (it) => {
  it.effect("adds nullable local project override columns idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE projection_projects (
          project_id TEXT PRIMARY KEY
        )
      `;

      yield* Migration0067;
      yield* Migration0067;

      const columns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('projection_projects')
      `;
      const names = columns.map((column) => column.name);
      assert.equal(names.includes("default_env_mode"), true);
      assert.equal(names.includes("icon_json"), true);
    }),
  );
});
