import type {
  McpInspectServerRequest,
  ProjectId,
  McpInspectServerResult,
  McpServerStatusesResult,
} from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ensureNativeApi } from "../nativeApi";

export function mcpInspectServerQueryOptions(
  input: Omit<McpInspectServerRequest, "projectId"> & {
    projectId: ProjectId | null;
    observation?: McpServerStatusesResult | undefined;
    enabled?: boolean;
  },
) {
  return queryOptions<McpInspectServerResult>({
    queryKey: [
      "mcp",
      "inspectServer",
      input.provider,
      input.projectId,
      input.instanceId ?? null,
      input.observation?.source ?? "configurationCheck",
      input.observation?.fingerprint ?? null,
      input.threadId ?? input.observation?.threadId ?? null,
      input.observation?.generation ?? null,
      input.observation?.desiredVersion ?? null,
      input.observation?.appliedVersion ?? null,
      input.serverName,
      input.ownership ?? "managed",
    ],
    enabled: input.projectId !== null && (input.enabled ?? true),
    queryFn: () => {
      if (!input.projectId) throw new Error("Select a project to read live server details.");
      return ensureNativeApi().mcp.inspectServer({
        provider: input.provider,
        projectId: input.projectId,
        ...(input.instanceId ? { instanceId: input.instanceId } : {}),
        serverName: input.serverName,
        ...(input.ownership ? { ownership: input.ownership } : {}),
        ...((input.threadId ?? input.observation?.threadId)
          ? { threadId: input.threadId ?? input.observation?.threadId }
          : {}),
      });
    },
  });
}
