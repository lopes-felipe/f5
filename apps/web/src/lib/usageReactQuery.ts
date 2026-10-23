import {
  UsageSummary as UsageSummarySchema,
  UsageAccounts,
  UsageQuotaHistory as UsageQuotaHistorySchema,
  type ProjectId,
  type UsageRange,
  type ProviderKind,
} from "@t3tools/contracts";
import { queryOptions, type Query, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { Schema } from "effect";
import { ensureNativeApi } from "../nativeApi";

export const usageQueryKeys = {
  summaries: ["usage", "summary"] as const,
  summary: (
    range: UsageRange,
    timeZone: string,
    provider?: ProviderKind,
    projectId?: ProjectId,
    hiddenProviders: ReadonlyArray<ProviderKind> = [],
  ) =>
    [
      "usage",
      "summary",
      range,
      timeZone,
      provider ?? "all",
      projectId ?? "all",
      hiddenProviders.toSorted().join(","),
    ] as const,
  accounts: ["usage", "accounts"] as const,
  quotaHistory: ["usage", "quota-history"] as const,
};

/** Stable mutation key so a pending forced refresh survives Limits remounts. */
export const USAGE_ACCOUNTS_FORCE_MUTATION_KEY = ["usage", "accounts", "force"] as const;

export function decodeUsageSummary(value: unknown) {
  return Schema.decodeUnknownSync(UsageSummarySchema)(value);
}

export function usageSummaryQueryOptions(input: {
  readonly range: UsageRange;
  readonly timeZone: string;
  readonly provider?: ProviderKind | undefined;
  readonly projectId?: ProjectId | undefined;
  readonly hiddenProviders?: ReadonlyArray<ProviderKind>;
  readonly enabled?: boolean;
}) {
  const { range, timeZone, provider, projectId } = input;
  const hiddenProviders = input.hiddenProviders?.toSorted() ?? [];
  return queryOptions({
    queryKey: usageQueryKeys.summary(range, timeZone, provider, projectId, hiddenProviders),
    queryFn: async () =>
      decodeUsageSummary(
        await ensureNativeApi().usage.getSummary({
          range,
          timeZone,
          ...(provider ? { provider } : {}),
          ...(projectId ? { projectId } : {}),
          ...(hiddenProviders.length > 0 ? { hiddenProviders } : {}),
        }),
      ),
    staleTime: 30_000,
    enabled: input.enabled ?? true,
  });
}

interface SummaryKeyState {
  revision: number;
  completed: number;
  pending: Promise<void> | null;
}

const summaryStates = new WeakMap<QueryClient, Map<string, SummaryKeyState>>();

function summaryStatesFor(client: QueryClient): Map<string, SummaryKeyState> {
  let states = summaryStates.get(client);
  if (!states) {
    const created = new Map<string, SummaryKeyState>();
    states = created;
    summaryStates.set(client, created);
    // Release per-key state when the query leaves the cache.
    client.getQueryCache().subscribe((event) => {
      if (event.type === "removed") created.delete(event.query.queryHash);
    });
  }
  return states;
}

async function settle(promise: Promise<unknown> | undefined): Promise<void> {
  try {
    await promise;
  } catch {
    // Failures surface through the query state; callers only need ordering.
  }
}

/**
 * Invalidates usage summaries with one logical in-flight request per exact
 * key. A request that started before the invalidation is awaited, then one
 * fresh request follows; repeated invalidations collapse into one trailing
 * refresh shared by every caller waiting on that revision. Keys without an
 * enabled observer are only marked stale.
 */
export function refreshUsageSummaries(
  client: QueryClient,
  queryKey: QueryKey = usageQueryKeys.summaries,
): Promise<void> {
  void client.invalidateQueries({ queryKey, refetchType: "none" });
  const states = summaryStatesFor(client);
  const pending = client
    .getQueryCache()
    .findAll({ queryKey })
    .flatMap((query) => {
      if (!query.isActive()) return [];
      let state = states.get(query.queryHash);
      if (!state) {
        state = { revision: 0, completed: 0, pending: null };
        states.set(query.queryHash, state);
      }
      state.revision++;
      if (!state.pending) state.pending = drainSummary(client, query, state);
      return [state.pending];
    });
  return Promise.all(pending).then(() => undefined);
}

async function drainSummary(
  client: QueryClient,
  query: Query,
  state: SummaryKeyState,
): Promise<void> {
  try {
    while (state.completed < state.revision) {
      // A fetch already in flight began before this invalidation: let it
      // finish, then request a fresh result.
      if (query.state.fetchStatus === "fetching") await settle(query.promise);
      if (!query.isActive()) {
        // The pre-invalidation response may have just committed and cleared
        // the stale flag; re-mark it so the next observer refetches.
        void client.invalidateQueries({
          queryKey: query.queryKey,
          exact: true,
          refetchType: "none",
        });
        return;
      }
      // Every invalidation seen before the fresh request starts is satisfied by it.
      const revision = state.revision;
      await settle(
        client.refetchQueries(
          { queryKey: query.queryKey, exact: true, type: "active" },
          { cancelRefetch: false },
        ),
      );
      state.completed = revision;
    }
  } finally {
    state.pending = null;
  }
}

export const decodeUsageAccounts = Schema.decodeUnknownSync(UsageAccounts);
export const accountJobsPending = (data: UsageAccounts | undefined) =>
  data?.some((account) => account.refreshState !== "idle") ?? false;

interface ForceIntent {
  consumed: boolean;
  promise: Promise<UsageAccounts> | null;
}

const forceIntents = new WeakMap<QueryClient, ForceIntent>();

export function usageAccountsQueryOptions() {
  return queryOptions({
    queryKey: usageQueryKeys.accounts,
    // The signal is deliberately unused: cancelling a read discards its
    // result without aborting the server-side refresh job.
    queryFn: async (context) => {
      const intent = forceIntents.get(context.client);
      let refresh: "force" | "if-stale" | "none";
      if (intent && !intent.consumed) {
        intent.consumed = true;
        refresh = "force";
      } else {
        const cached = context.client.getQueryData<UsageAccounts>(usageQueryKeys.accounts);
        refresh = accountJobsPending(cached) ? "none" : "if-stale";
      }
      return decodeUsageAccounts(await ensureNativeApi().usage.getAccounts({ refresh }));
    },
    staleTime: 300_000,
    retry: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchIntervalInBackground: false,
    refetchInterval: (query) => (accountJobsPending(query.state.data) ? 1_000 : 300_000),
  });
}

/**
 * Forces an account refresh through the ordinary accounts query. The intent
 * is registered synchronously so duplicate requests share one promise, the
 * current read is logically cancelled so a late ordinary response cannot
 * commit, and ordinary triggers join the forced fetch while it runs.
 */
export function forceRefreshUsageAccounts(client: QueryClient): Promise<UsageAccounts> {
  const existing = forceIntents.get(client);
  if (existing?.promise) return existing.promise;
  const intent: ForceIntent = { consumed: false, promise: null };
  forceIntents.set(client, intent);
  intent.promise = (async () => {
    try {
      await client.cancelQueries({ queryKey: usageQueryKeys.accounts });
      // If an ordinary trigger started a fetch meanwhile, it consumed the
      // intent as the forced read and this call joins it.
      return await client.fetchQuery({ ...usageAccountsQueryOptions(), staleTime: 0 });
    } finally {
      if (forceIntents.get(client) === intent) forceIntents.delete(client);
    }
  })();
  return intent.promise;
}

/** Invalidates accounts without cancelling an in-flight (possibly forced) read. */
export function invalidateUsageAccounts(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: usageQueryKeys.accounts }, { cancelRefetch: false });
}

export function usageQuotaHistoryQueryOptions(enabled = true) {
  return queryOptions({
    queryKey: usageQueryKeys.quotaHistory,
    queryFn: async () =>
      Schema.decodeUnknownSync(UsageQuotaHistorySchema)(
        await ensureNativeApi().usage.getQuotaHistory(),
      ),
    staleTime: 60_000,
    retry: false,
    refetchInterval: false,
    enabled,
  });
}
