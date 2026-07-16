import type { ReviewDiffScope, ThreadId } from "@t3tools/contracts";
import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { ensureNativeApi } from "../nativeApi";

export const reviewQueryKeys = {
  all: ["review"] as const,
  preview: (input: {
    threadId: ThreadId | null;
    scope: ReviewDiffScope | null;
    baseRef: string | null;
    ignoreWhitespace: boolean;
  }) => ["review", "preview", input] as const,
};

export function invalidateReviewQueries(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: reviewQueryKeys.all });
}

export function reviewPreviewDiffQueryOptions(input: {
  threadId: ThreadId | null;
  scope: ReviewDiffScope | null;
  baseRef: string | null;
  ignoreWhitespace: boolean;
  autoRefresh?: boolean;
  refetchIntervalMs?: number;
}) {
  return queryOptions({
    queryKey: reviewQueryKeys.preview({
      threadId: input.threadId,
      scope: input.scope,
      baseRef: input.baseRef,
      ignoreWhitespace: input.ignoreWhitespace,
    }),
    queryFn: async () => {
      if (!input.threadId || !input.scope) throw new Error("Review diff is unavailable.");
      return ensureNativeApi().review.previewDiff({
        threadId: input.threadId,
        scope: input.scope,
        ...(input.baseRef ? { baseRef: input.baseRef } : {}),
        ignoreWhitespace: input.ignoreWhitespace,
      });
    },
    enabled: input.threadId !== null && input.scope !== null,
    staleTime: 1_000,
    refetchInterval: input.autoRefresh ? Math.max(1_000, input.refetchIntervalMs ?? 60_000) : false,
    refetchOnWindowFocus: input.autoRefresh ? "always" : false,
    refetchOnReconnect: true,
  });
}
