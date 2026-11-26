import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { ensureNativeApi } from "../nativeApi";
import { onServerWelcome } from "../wsNativeApi";
import { isMcpQueryAffected, mcpQueryKeys } from "./mcpReactQuery";

const subscriptions = new WeakMap<QueryClient, { count: number; unsubscribe: () => void }>();

/**
 * Keeps MCP queries current from pushed status events. Sign-in and hub status are
 * not polled, so every view that shows them mounts this; one subscription per
 * query client is shared however many views do. Events sent while the socket was
 * down are lost, so a (re)connect re-reads every MCP query.
 */
export function useMcpStatusUpdates(enabled = true): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const existing = subscriptions.get(queryClient);
    if (existing) existing.count += 1;
    else {
      const stopEvents = ensureNativeApi().mcp.onStatusUpdated((event) => {
        void queryClient.invalidateQueries({
          predicate: (query) => isMcpQueryAffected(query.queryKey, event),
        });
      });
      // A welcome already received fires at once; only later (re)connects matter here.
      let subscribed = false;
      const stopWelcome = onServerWelcome(() => {
        if (!subscribed) return;
        // Requests started on the dropped socket never answer; restart them too.
        void queryClient
          .cancelQueries({
            queryKey: mcpQueryKeys.all,
            predicate: (query) =>
              query.state.data === undefined && query.state.fetchStatus === "fetching",
          })
          .then(() => queryClient.invalidateQueries({ queryKey: mcpQueryKeys.all }));
      });
      subscribed = true;
      subscriptions.set(queryClient, {
        count: 1,
        unsubscribe: () => {
          stopEvents();
          stopWelcome();
        },
      });
    }
    return () => {
      const current = subscriptions.get(queryClient);
      if (!current) return;
      current.count -= 1;
      if (current.count > 0) return;
      subscriptions.delete(queryClient);
      current.unsubscribe();
    };
  }, [queryClient, enabled]);
}
