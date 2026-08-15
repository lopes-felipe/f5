import { UsageSummary as UsageSummarySchema, type UsageRange } from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";
import { Schema } from "effect";

import { ensureNativeApi } from "../nativeApi";

export const usageQueryKeys = {
  summary: (range: UsageRange, timeZone: string) => ["usage", "summary", range, timeZone] as const,
};

export function decodeUsageSummary(value: unknown) {
  return Schema.decodeUnknownSync(UsageSummarySchema)(value);
}

export function usageSummaryQueryOptions(range: UsageRange, timeZone: string) {
  return queryOptions({
    queryKey: usageQueryKeys.summary(range, timeZone),
    queryFn: async () =>
      decodeUsageSummary(await ensureNativeApi().usage.getSummary({ range, timeZone })),
    staleTime: 30_000,
  });
}
