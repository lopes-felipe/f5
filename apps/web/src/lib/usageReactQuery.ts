import {
  UsageSummary as UsageSummarySchema,
  UsageAccounts,
  UsageQuotaHistory as UsageQuotaHistorySchema,
  UsageThreadTurns as UsageThreadTurnsSchema,
  type ProjectId,
  type ThreadId,
  type UsageThreadTurns,
  type UsageTurnFact,
  type UsageRange,
  type ProviderKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { queryOptions, type Query, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { Schema } from "effect";
import { mergeThreadTurn } from "../components/chat/cacheIndicator.logic";
import { ensureNativeApi } from "../nativeApi";
import { rpcQueryContext, rpcQueryMeta } from "./rpcQueryContext";

export const usageQueryKeys = {
  summaries: ["usage", "summary"] as const,
  summary: (
    range: UsageRange,
    timeZone: string,
    provider?: ProviderKind,
    projectId?: ProjectId,
    hiddenProviders: ReadonlyArray<ProviderKind> = [],
    comparePrevious = false,
  ) =>
    [
      "usage",
      "summary",
      range,
      timeZone,
      provider ?? "all",
      projectId ?? "all",
      hiddenProviders.toSorted().join(","),
      // Only comparison summaries carry the extra segment, so plain keys keep their shape.
      ...(comparePrevious ? (["compare"] as const) : []),
    ] as const,
  accounts: ["usage", "accounts"] as const,
  quotaHistory: ["usage", "quota-history"] as const,
  threadTurns: (threadId: ThreadId) => ["usage", "thread-turns", threadId] as const,
};

export function decodeUsageThreadTurns(value: unknown) {
  return Schema.decodeUnknownSync(UsageThreadTurnsSchema)(value);
}

// Facts recorded while a thread's history request is in flight, per request.
// The server may have read its rows before the projector wrote such a fact,
// and the response replaces whatever was merged into the cache meanwhile.
const inFlightThreadFacts = new Map<ThreadId, Set<UsageTurnFact[]>>();

/** Hands a live fact to every in-flight history request for its thread. */
export function noteLiveThreadTurnFact(fact: UsageTurnFact): void {
  for (const buffer of inFlightThreadFacts.get(fact.threadId) ?? []) buffer.push(fact);
}

async function fetchThreadTurns(
  threadId: ThreadId,
  context: Parameters<typeof rpcQueryContext>[0],
): Promise<UsageThreadTurns> {
  const buffer: UsageTurnFact[] = [];
  const buffers = inFlightThreadFacts.get(threadId) ?? new Set();
  inFlightThreadFacts.set(threadId, buffers.add(buffer));
  try {
    const history = decodeUsageThreadTurns(
      await ensureNativeApi().usage.getThreadTurns({ threadId }, rpcQueryContext(context)),
    );
    // Merging is idempotent, so facts the response already holds are no-ops.
    return buffer.reduce(mergeThreadTurn, history);
  } finally {
    buffers.delete(buffer);
    if (buffers.size === 0) inFlightThreadFacts.delete(threadId);
  }
}

/** One thread's recorded turn usage; live facts are merged in by `useThreadCacheTurns`. */
export function usageThreadTurnsQueryOptions(input: {
  readonly threadId: ThreadId;
  readonly enabled: boolean;
}) {
  return queryOptions({
    queryKey: usageQueryKeys.threadTurns(input.threadId),
    queryFn: (context) => fetchThreadTurns(input.threadId, context),
    meta: rpcQueryMeta("refresh-background"),
    // Facts are merged live only while the thread is open, so reopening it
    // refetches what was recorded meanwhile. Focus adds nothing the live
    // merge has not; reconnects refetch explicitly.
    staleTime: 0,
    refetchOnWindowFocus: false,
    enabled: input.enabled,
  });
}

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
  /** Also fetch the previous period's buckets for the chart overlay. */
  readonly comparePrevious?: boolean;
  readonly enabled?: boolean;
}) {
  const { range, timeZone, provider, projectId } = input;
  const comparePrevious = input.comparePrevious ?? false;
  const hiddenProviders = input.hiddenProviders?.toSorted() ?? [];
  return queryOptions({
    queryKey: usageQueryKeys.summary(
      range,
      timeZone,
      provider,
      projectId,
      hiddenProviders,
      comparePrevious,
    ),
    queryFn: async (context) =>
      decodeUsageSummary(
        await ensureNativeApi().usage.getSummary(
          {
            range,
            timeZone,
            ...(provider ? { provider } : {}),
            ...(projectId ? { projectId } : {}),
            ...(hiddenProviders.length > 0 ? { hiddenProviders } : {}),
            ...(comparePrevious ? { includePreviousBuckets: true } : {}),
          },
          rpcQueryContext(context),
        ),
      ),
    meta: rpcQueryMeta("refresh-background"),
    staleTime: 30_000,
    refetchInterval: (query) =>
      query.state.data?.nativeHistoryStatus === "refreshing" ? 1_000 : false,
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

interface RefreshRequest {
  refresh: "force" | "if-stale";
  providerInstanceId?: ProviderInstanceId | undefined;
  promise: Promise<UsageAccounts>;
  resolve: (accounts: UsageAccounts) => void;
  reject: (error: unknown) => void;
}
const refreshQueues = new WeakMap<QueryClient, RefreshRequest[]>();

export function usageAccountsQueryOptions() {
  return queryOptions({
    queryKey: usageQueryKeys.accounts,
    queryFn: async (context) =>
      decodeUsageAccounts(
        await ensureNativeApi().usage.getAccounts(
          { refresh: "none" },
          rpcQueryContext(context, { forwardSignal: false }),
        ),
      ),
    meta: rpcQueryMeta("refresh-background"),
    staleTime: 300_000,
    retry: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchIntervalInBackground: false,
    refetchInterval: (query) => (accountJobsPending(query.state.data) ? 1_000 : 300_000),
  });
}

/** Serialize probes independently of snapshot reads; global requests cover scoped callers. */
export function refreshUsageAccounts(
  client: QueryClient,
  refresh: "force" | "if-stale" = "if-stale",
  providerInstanceId?: ProviderInstanceId,
): Promise<UsageAccounts> {
  let queue = refreshQueues.get(client);
  if (!queue) {
    queue = [];
    refreshQueues.set(client, queue);
  }
  const covered = queue.find(
    (job) =>
      (job.refresh === "force" || refresh === "if-stale") &&
      (job.providerInstanceId === undefined || job.providerInstanceId === providerInstanceId),
  );
  if (covered) return covered.promise;
  let resolve!: RefreshRequest["resolve"];
  let reject!: RefreshRequest["reject"];
  const promise = new Promise<UsageAccounts>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const job: RefreshRequest = { refresh, providerInstanceId, promise, resolve, reject };
  queue.push(job);
  if (queue.length === 1) void drainAccountRefreshes(client, queue);
  return promise;
}

async function drainAccountRefreshes(client: QueryClient, queue: RefreshRequest[]) {
  while (queue.length) {
    const job = queue[0]!;
    try {
      await client.cancelQueries({ queryKey: usageQueryKeys.accounts, exact: true });
      const accounts = await client.fetchQuery({
        ...usageAccountsQueryOptions(),
        staleTime: 0,
        queryFn: async () =>
          decodeUsageAccounts(
            await ensureNativeApi().usage.getAccounts(
              {
                refresh: job.refresh,
                ...(job.providerInstanceId ? { providerInstanceId: job.providerInstanceId } : {}),
              },
              { priority: "interactive" },
            ),
          ),
      });
      job.resolve(accounts);
    } catch (error) {
      job.reject(error);
    } finally {
      queue.shift();
    }
  }
  refreshQueues.delete(client);
}

export function forceRefreshUsageAccounts(
  client: QueryClient,
  providerInstanceId?: ProviderInstanceId,
): Promise<UsageAccounts> {
  return refreshUsageAccounts(client, "force", providerInstanceId);
}

/** Reads the background sampler's snapshots without starting any provider probes. */
export function usageCachedAccountsQueryOptions(enabled: boolean) {
  return queryOptions({
    queryKey: usageQueryKeys.accounts,
    queryFn: async (context) =>
      decodeUsageAccounts(
        await ensureNativeApi().usage.getAccounts({ refresh: "none" }, rpcQueryContext(context)),
      ),
    meta: rpcQueryMeta("refresh-background"),
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchIntervalInBackground: false,
    refetchInterval: (query) => (accountJobsPending(query.state.data) ? 1_000 : 60_000),
    enabled,
  });
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
