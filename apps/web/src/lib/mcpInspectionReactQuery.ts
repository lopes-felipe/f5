import type {
  McpInspectServerRequest,
  ProjectId,
  McpInspectServerResult,
  McpServerStatusesResult,
} from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ensureNativeApi } from "../nativeApi";
import { mcpQueryKeys } from "./mcpReactQuery";

export function mcpInspectServerQueryOptions(
  input: Omit<McpInspectServerRequest, "projectId"> & {
    projectId: ProjectId | null;
    observation?: McpServerStatusesResult | undefined;
    enabled?: boolean;
  },
) {
  return queryOptions<McpInspectServerResult>({
    queryKey: [
      ...mcpQueryKeys.inspectServer(
        input.provider,
        input.projectId,
        input.instanceId ?? null,
        input.serverName,
        input.threadId ?? input.observation?.threadId ?? null,
      ),
      {
        source: input.observation?.source ?? "configurationCheck",
        fingerprint: input.observation?.fingerprint ?? null,
        generation: input.observation?.generation ?? null,
        desiredVersion: input.observation?.desiredVersion ?? null,
        appliedVersion: input.observation?.appliedVersion ?? null,
        ownership: input.ownership ?? "managed",
      },
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
