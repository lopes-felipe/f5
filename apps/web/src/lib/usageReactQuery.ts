import {
  UsageSummary as UsageSummarySchema,
  UsageAccounts,
  type UsageRange,
  type ProviderKind,
} from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";
import { Schema } from "effect";
import { ensureNativeApi } from "../nativeApi";

export const usageQueryKeys = {
  summary: (range: UsageRange, timeZone: string, provider?: ProviderKind) =>
    ["usage", "summary", range, timeZone, provider ?? "all"] as const,
  accounts: ["usage", "accounts"] as const,
};
export function decodeUsageSummary(value: unknown) {
  return Schema.decodeUnknownSync(UsageSummarySchema)(value);
}
export function usageSummaryQueryOptions(
  range: UsageRange,
  timeZone: string,
  provider?: ProviderKind,
) {
  return queryOptions({
    queryKey: usageQueryKeys.summary(range, timeZone, provider),
    queryFn: async () =>
      decodeUsageSummary(
        await ensureNativeApi().usage.getSummary({
          range,
          timeZone,
          ...(provider ? { provider } : {}),
        }),
      ),
    staleTime: 30_000,
  });
}
export const decodeUsageAccounts = Schema.decodeUnknownSync(UsageAccounts);
export const accountJobsPending = (data: UsageAccounts | undefined) =>
  data?.some((account) => account.refreshState !== "idle") ?? false;
export function usageAccountsQueryOptions() {
  return queryOptions({
    queryKey: usageQueryKeys.accounts,
    queryFn: async (context) => {
      const cached = context.client.getQueryData<UsageAccounts>(usageQueryKeys.accounts);
      return decodeUsageAccounts(
        await ensureNativeApi().usage.getAccounts({
          refresh: accountJobsPending(cached) ? "none" : "if-stale",
        }),
      );
    },
    staleTime: 300_000,
    retry: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchIntervalInBackground: false,
    refetchInterval: (query) => (accountJobsPending(query.state.data) ? 1_000 : false),
  });
}
