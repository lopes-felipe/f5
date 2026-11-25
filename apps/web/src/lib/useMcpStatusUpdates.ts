import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { ensureNativeApi } from "../nativeApi";
import { isMcpQueryAffected } from "./mcpReactQuery";

const subscriptions = new WeakMap<QueryClient, { count: number; unsubscribe: () => void }>();

/**
 * Keeps MCP queries current from pushed status events. Sign-in and hub status are
 * not polled, so every view that shows them mounts this; one subscription per
 * query client is shared however many views do.
 */
export function useMcpStatusUpdates(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const existing = subscriptions.get(queryClient);
    if (existing) existing.count += 1;
    else
      subscriptions.set(queryClient, {
        count: 1,
        unsubscribe: ensureNativeApi().mcp.onStatusUpdated((event) => {
          void queryClient.invalidateQueries({
            predicate: (query) => isMcpQueryAffected(query.queryKey, event),
          });
        }),
      });
    return () => {
      const current = subscriptions.get(queryClient);
      if (!current) return;
      current.count -= 1;
      if (current.count > 0) return;
      subscriptions.delete(queryClient);
      current.unsubscribe();
    };
  }, [queryClient]);
}
