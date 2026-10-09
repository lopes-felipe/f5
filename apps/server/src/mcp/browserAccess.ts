import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { ThreadId } from "@t3tools/contracts";
import {
  agentBrowserPolicyFromSettings,
  DISABLED_AGENT_BROWSER_POLICY,
  type AgentBrowserPolicy,
} from "@t3tools/shared/projectSettings";
import { ServerSettingsService } from "../serverSettings";

export { agentBrowserPolicyFromSettings, DISABLED_AGENT_BROWSER_POLICY, type AgentBrowserPolicy };

export type ResolveAgentBrowserPolicy = (threadId: ThreadId) => Effect.Effect<AgentBrowserPolicy>;

/** Both MCP installation and every invocation consult the current server-owned policy. */
export function resolveAgentBrowserPolicy(threadId: ThreadId): Effect.Effect<AgentBrowserPolicy> {
  return Effect.gen(function* () {
    const settingsService = yield* Effect.serviceOption(ServerSettingsService);
    if (Option.isNone(settingsService)) return DISABLED_AGENT_BROWSER_POLICY;
    const settings = yield* settingsService.value.getSettings;
    const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
    if (Option.isNone(sql)) return agentBrowserPolicyFromSettings(settings, undefined);
    const thread = (yield* sql.value<{
      projectId: string;
    }>`SELECT project_id AS "projectId" FROM projection_threads WHERE thread_id=${threadId}`)[0];
    return agentBrowserPolicyFromSettings(settings, thread?.projectId);
  }).pipe(Effect.catch(() => Effect.succeed(DISABLED_AGENT_BROWSER_POLICY)));
}

export function browserAccessAllowed(threadId: ThreadId): Effect.Effect<boolean> {
  return resolveAgentBrowserPolicy(threadId).pipe(Effect.map((policy) => policy.previewAutomation));
}
