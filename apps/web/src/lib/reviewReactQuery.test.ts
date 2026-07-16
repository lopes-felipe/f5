import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  invalidateReviewQueries,
  reviewPreviewDiffQueryOptions,
  reviewQueryKeys,
} from "./reviewReactQuery";

describe("invalidateReviewQueries", () => {
  it("invalidates active review previews when Git status changes", async () => {
    const queryClient = new QueryClient();
    const invalidateQueries = queryClient.invalidateQueries.bind(queryClient);
    const calls: unknown[] = [];
    queryClient.invalidateQueries = ((filters, options) => {
      calls.push(filters);
      return invalidateQueries(filters, options);
    }) as typeof queryClient.invalidateQueries;

    await invalidateReviewQueries(queryClient);

    expect(calls).toEqual([{ queryKey: reviewQueryKeys.all }]);
  });
});

describe("reviewPreviewDiffQueryOptions", () => {
  it("polls an open review diff when Git auto-refresh is enabled", () => {
    const options = reviewPreviewDiffQueryOptions({
      threadId: null,
      scope: null,
      baseRef: null,
      ignoreWhitespace: false,
      autoRefresh: true,
      refetchIntervalMs: 30_000,
    });

    expect(options.refetchInterval).toBe(30_000);
    expect(options.refetchOnWindowFocus).toBe("always");
  });
});
