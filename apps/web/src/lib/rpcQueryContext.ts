import type { NativeRequestContext } from "@t3tools/contracts";
import type { QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * `meta.priority` for queries: `background` always yields ordinary request
 * slots; `refresh-background` does so only once the query has data, so the
 * first load stays interactive while polling and event refetches do not.
 */
export type RpcQueryPriority = "interactive" | "background" | "refresh-background";

export function rpcQueryMeta(priority: RpcQueryPriority): { readonly priority: RpcQueryPriority } {
  return { priority };
}

interface RpcQueryFunctionContext {
  readonly client: QueryClient;
  readonly queryKey: QueryKey;
  readonly signal: AbortSignal;
  readonly meta: Record<string, unknown> | undefined;
}

/**
 * Builds the transport context for a query function: forwards React Query's
 * abort signal (so an unsent read leaves its queue on cancellation) and the
 * query's `meta.priority`.
 */
export function rpcQueryContext(
  context: RpcQueryFunctionContext,
  options: { readonly forwardSignal?: boolean } = {},
): NativeRequestContext {
  const priority = context.meta?.priority;
  const background =
    priority === "background" ||
    (priority === "refresh-background" &&
      context.client.getQueryState(context.queryKey)?.data !== undefined);
  return {
    priority: background ? "background" : "interactive",
    // Reading `signal` marks the query cancellable, so only touch it when forwarding.
    ...(options.forwardSignal === false ? {} : { signal: context.signal }),
  };
}
