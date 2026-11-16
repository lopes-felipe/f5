import type { McpReconnectServerRequest } from "@t3tools/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { ensureNativeApi } from "../../../nativeApi";
import { mcpQueryKeys, resetMcpRuntimePolling } from "../../../lib/mcpReactQuery";
import { toastManager } from "../../ui/toast";

export async function reconnectMcpServer(
  queryClient: QueryClient,
  input: McpReconnectServerRequest,
) {
  const result = await ensureNativeApi().mcp.reconnectServer(input);
  toastManager.add({
    type: result.failures.length ? "warning" : "success",
    title: result.sessionsReconnected
      ? `Reconnected in ${result.sessionsReconnected} running session(s)`
      : result.failures.length
        ? "Some sessions could not reconnect"
        : "No running session uses this server; it connects when a session starts",
    ...(result.failures.length
      ? {
          description: result.failures
            .map((failure) => `${failure.threadId ?? "Settings connection"}: ${failure.message}`)
            .join("\n"),
        }
      : {}),
  });
  resetMcpRuntimePolling(queryClient);
  await queryClient.invalidateQueries({ queryKey: mcpQueryKeys.all });
  return result;
}
