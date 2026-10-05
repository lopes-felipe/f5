import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { ProjectId, ThreadId } from "@t3tools/contracts";
import { ServerSettingsService } from "../serverSettings";
/** Both MCP installation and every invocation consult the current server-owned policy. */
export function browserAccessAllowed(threadId: ThreadId): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const settingsService = yield* Effect.serviceOption(ServerSettingsService);
    if (Option.isNone(settingsService)) return false;
    const settings = yield* settingsService.value.getSettings;
    const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
    if (Option.isNone(sql)) return settings.enableAgentBrowserAccess;
    const thread = (yield* sql.value<{
      projectId: string;
    }>`SELECT project_id AS "projectId" FROM projection_threads WHERE thread_id=${threadId}`)[0];
    return thread
      ? (settings.projectSettingsOverrides[thread.projectId as ProjectId]
          ?.enableAgentBrowserAccess ?? settings.enableAgentBrowserAccess)
      : settings.enableAgentBrowserAccess;
  }).pipe(Effect.catch(() => Effect.succeed(false)));
}
