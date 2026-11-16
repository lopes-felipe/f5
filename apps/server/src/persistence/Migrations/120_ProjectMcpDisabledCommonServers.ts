import RepairProjectMcpConfigs from "./043_ProjectMcpConfigsSchemaRepair.ts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Older installations can have an advanced ledger with a missing MCP table.
  yield* RepairProjectMcpConfigs;
  const columns = yield* sql<{
    name: string;
  }>`SELECT name FROM pragma_table_info('project_mcp_configs')`;
  if (columns.some((column) => column.name === "disabled_common_servers_json")) return;
  yield* sql`ALTER TABLE project_mcp_configs ADD COLUMN disabled_common_servers_json TEXT NOT NULL DEFAULT '[]'`;
});
