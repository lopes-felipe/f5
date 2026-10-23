import {
  AGENT_BRIDGE_ACTIVATION_VERSION,
  type ScheduleAuthority,
  type ServerSettings,
} from "@t3tools/contracts";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
/** One persisted authority check shared by preparation, continuations and final delivery. */
export const scheduleAuthorityCurrent = (
  authority: ScheduleAuthority,
  projectId: string,
  settings: ServerSettings,
  sql: SqlClient.SqlClient,
) =>
  Effect.gen(function* () {
    if (authority.kind === "user") return true;
    if (
      !settings.agentBridge.enabled ||
      settings.agentBridge.activationVersion !== AGENT_BRIDGE_ACTIVATION_VERSION ||
      !settings.agentBridge.exposedProjectIds.some((id) => id === projectId)
    )
      return false;
    const rows = yield* sql<{
      scopes_json: string;
      project_ids_json: string;
      grant_generation: number;
      revoked_at: string | null;
    }>`SELECT scopes_json,project_ids_json,grant_generation,revoked_at FROM agent_bridge_clients WHERE id=${authority.clientId}`;
    const client = rows[0];
    return (
      !!client &&
      !client.revoked_at &&
      client.grant_generation === authority.grantGeneration &&
      (JSON.parse(client.scopes_json) as string[]).includes("f5.schedules") &&
      (authority.clientId === "local" ||
        (JSON.parse(client.project_ids_json) as string[]).includes(projectId))
    );
  });
