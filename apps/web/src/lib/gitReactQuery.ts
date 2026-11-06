import type { ProjectId, ThreadId } from "@t3tools/contracts";
import type { GitListBranchesResult, GitStackedAction, GitStatusResult } from "@t3tools/contracts";
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { ensureNativeApi } from "../nativeApi";
import { rpcQueryContext, rpcQueryMeta, type RpcQueryPriority } from "./rpcQueryContext";

const GIT_STATUS_STALE_TIME_MS = 5_000;
const GIT_STATUS_REFETCH_INTERVAL_MS = 60_000;
const GIT_BRANCHES_STALE_TIME_MS = 15_000;

export const gitQueryKeys = {
  all: ["git"] as const,
  worktrees: (projectId: ProjectId | null) => ["worktrees", "list", projectId] as const,
  status: (cwd: string | null) => ["git", "status", cwd] as const,
  branches: (cwd: string | null) => ["git", "branches", cwd] as const,
};

export const gitMutationKeys = {
  init: (cwd: string | null) => ["git", "mutation", "init", cwd] as const,
  checkout: (cwd: string | null) => ["git", "mutation", "checkout", cwd] as const,
  runStackedAction: (cwd: string | null) => ["git", "mutation", "run-stacked-action", cwd] as const,
  pull: (cwd: string | null) => ["git", "mutation", "pull", cwd] as const,
  preparePullRequestThread: (cwd: string | null) =>
    ["git", "mutation", "prepare-pull-request-thread", cwd] as const,
};

interface GitAutoRefreshQueryOptionsInput {
  cwd: string | null;
  autoRefresh?: boolean;
  staleTimeMs?: number;
  refetchIntervalMs?: number;
}

const pendingGitInvalidations = new WeakMap<
  QueryClient,
  Map<string | null, { dirty: boolean; done: Promise<void> }>
>();

export function invalidateGitQueries(
  queryClient: QueryClient,
  input?: { cwd?: string | null },
): Promise<void> {
  const cwd = input?.cwd ?? null;
  let pending = pendingGitInvalidations.get(queryClient);
  if (!pending) {
    pending = new Map();
    pendingGitInvalidations.set(queryClient, pending);
  }
  const existing = pending.get(cwd);
  if (existing) {
    existing.dirty = true;
    return existing.done;
  }
  const entry = { dirty: false, done: Promise.resolve() };
  pending.set(cwd, entry);
  entry.done = (async () => {
    do {
      entry.dirty = false;
      const queryKeys =
        cwd === null ? [gitQueryKeys.all] : [gitQueryKeys.status(cwd), gitQueryKeys.branches(cwd)];
      // Wait for existing reads before the one dirty rerun. A refresh may have
      // finished after those reads captured their upstream metadata.
      const reads = queryClient
        .getQueryCache()
        .findAll({ queryKey: cwd === null ? gitQueryKeys.all : ["git"] })
        .filter(
          (query) =>
            query.state.fetchStatus === "fetching" && (cwd === null || query.queryKey[2] === cwd),
        )
        .map((query) => query.promise?.catch(() => undefined));
      await Promise.all(reads);
      await Promise.all(
        queryKeys.map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false }),
        ),
      );
    } while (entry.dirty);
  })().finally(() => {
    if (pending.get(cwd) === entry) pending.delete(cwd);
  });
  return entry.done;
}

export function gitStatusQueryOptions({
  cwd,
  autoRefresh = true,
  staleTimeMs,
  refetchIntervalMs,
  includeRemote = autoRefresh,
  refetchOnFocus = "always",
  refetchOnReconnect = "always",
  priority = "refresh-background",
}: GitAutoRefreshQueryOptionsInput & {
  /**
   * false reads local status only, without fetching a stale upstream. Defaults to
   * `autoRefresh`: with automatic refresh off, opening a checkout never fetches either.
   */
  includeRemote?: boolean;
  /** `true` respects `staleTime`; `"always"` refetches on every focus. */
  refetchOnFocus?: boolean | "always";
  refetchOnReconnect?: boolean | "always";
  /** Polling and reconnect refreshes are background reads once a status is loaded. */
  priority?: RpcQueryPriority;
}) {
  return queryOptions({
    // Local-only results stay under their own key so they never stand in for a refreshed status.
    queryKey: includeRemote ? gitQueryKeys.status(cwd) : [...gitQueryKeys.status(cwd), "local"],
    queryFn: async (context) => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("Git status is unavailable.");
      return api.git.status(
        includeRemote ? { cwd } : { cwd, includeRemote: false },
        rpcQueryContext(context),
      );
    },
    meta: rpcQueryMeta(priority),
    enabled: cwd !== null,
    staleTime: autoRefresh ? (staleTimeMs ?? GIT_STATUS_STALE_TIME_MS) : Infinity,
    refetchOnWindowFocus: autoRefresh ? refetchOnFocus : false,
    refetchOnReconnect: autoRefresh ? refetchOnReconnect : false,
    refetchInterval: autoRefresh ? (refetchIntervalMs ?? GIT_STATUS_REFETCH_INTERVAL_MS) : false,
  });
}

/** Ref lists refresh on connection or invalidation; the status polling interval does not apply. */
export function gitBranchesQueryOptions({
  cwd,
  autoRefresh = true,
  staleTimeMs,
}: Omit<GitAutoRefreshQueryOptionsInput, "refetchIntervalMs">) {
  return queryOptions({
    queryKey: gitQueryKeys.branches(cwd),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("Git branches are unavailable.");
      return api.git.listBranches({ cwd, refresh: true });
    },
    enabled: cwd !== null,
    staleTime: autoRefresh ? (staleTimeMs ?? GIT_BRANCHES_STALE_TIME_MS) : Infinity,
    gcTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: autoRefresh ? "always" : false,
    refetchInterval: false,
  });
}

/**
 * Re-reads local refs (no fetch, no PR lookup). When another branch is checked out than the
 * cached status shows, or HEAD is detached, the status moves to it with remote counts and the
 * PR cleared, so the previous branch and its PR are not shown. The next status refresh fills
 * remote state in. A failed refs read changes nothing: cached refs may be older than status.
 */
export async function refreshCheckedOutGitBranch(queryClient: QueryClient, cwd: string | null) {
  if (cwd === null) return;
  let refs: GitListBranchesResult;
  try {
    refs = await queryClient.fetchQuery({ ...gitBranchesQueryOptions({ cwd }), staleTime: 0 });
  } catch {
    return;
  }
  const localRefs = refs.branches.filter((ref) => !ref.isRemote);
  if (!refs.isRepo || refs.worktreeMissing === true || localRefs.length === 0) return;
  // HEAD is read per checkout, so no current local ref means a detached HEAD.
  const branch = localRefs.find((ref) => ref.current)?.name ?? null;
  const statusKey = gitQueryKeys.status(cwd);
  for (const queryKey of [statusKey, [...statusKey, "local"]]) {
    const state = queryClient.getQueryState<GitStatusResult>(queryKey);
    const status = state?.data;
    if (!state || !status || status.worktreeMissing === true || status.branch === branch) continue;
    // A status read that started before the refs read must not restore the previous branch.
    await queryClient.cancelQueries({ queryKey, exact: true });
    queryClient.setQueryData<GitStatusResult>(
      queryKey,
      (current) =>
        !current || current.branch === branch
          ? current
          : {
              ...current,
              branch,
              hasUpstream: false,
              aheadCount: 0,
              behindCount: 0,
              pr: null,
              changeRequest: null,
            },
      // Keep its age, so the moved status refreshes on the usual schedule.
      { updatedAt: state.dataUpdatedAt },
    );
  }
}

const THREAD_PULL_REQUEST_REFRESH_MS = 5 * 60_000;

/**
 * The state of a PR linked to a thread. Shared by sidebar rows and View PR (same key, same
 * cache), outside the `git` key root so git actions do not refetch it. Open PRs refresh every
 * five minutes; merged and closed PRs stop polling.
 */
export function threadPullRequestQueryOptions(input: {
  readonly cwd: string | null;
  readonly url: string;
  readonly enabled?: boolean;
}) {
  return queryOptions({
    queryKey: ["thread-pull-request", input.cwd, input.url] as const,
    queryFn: async (context) => {
      if (!input.cwd) throw new Error("Pull request lookup is unavailable.");
      return ensureNativeApi().git.resolvePullRequest(
        { cwd: input.cwd, reference: input.url },
        rpcQueryContext(context),
      );
    },
    meta: rpcQueryMeta("background"),
    enabled: input.cwd !== null && input.enabled !== false,
    staleTime: THREAD_PULL_REQUEST_REFRESH_MS,
    refetchInterval: (query) =>
      query.state.data && query.state.data.pullRequest.state !== "open"
        ? false
        : THREAD_PULL_REQUEST_REFRESH_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
  });
}

export function gitResolvePullRequestQueryOptions(input: {
  cwd: string | null;
  reference: string | null;
}) {
  return queryOptions({
    queryKey: ["git", "pull-request", input.cwd, input.reference] as const,
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd || !input.reference) {
        throw new Error("Pull request lookup is unavailable.");
      }
      return api.git.resolvePullRequest({ cwd: input.cwd, reference: input.reference });
    },
    enabled: input.cwd !== null && input.reference !== null,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function gitInitMutationOptions(input: { cwd: string | null; queryClient: QueryClient }) {
  return mutationOptions({
    mutationKey: gitMutationKeys.init(input.cwd),
    mutationFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git init is unavailable.");
      return api.git.init({ cwd: input.cwd });
    },
    onSuccess: async () => {
      await invalidateGitQueries(input.queryClient, { cwd: input.cwd });
    },
  });
}

export function gitCheckoutMutationOptions(input: {
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.checkout(input.cwd),
    mutationFn: async (branch: string) => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git checkout is unavailable.");
      return api.git.checkout({ cwd: input.cwd, branch });
    },
    onSuccess: async () => {
      await invalidateGitQueries(input.queryClient, { cwd: input.cwd });
    },
  });
}

export function gitRunStackedActionMutationOptions(input: {
  threadId?: ThreadId | null;
  cwd: string | null;
  queryClient: QueryClient;
  model?: string | null;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.runStackedAction(input.cwd),
    mutationFn: async ({
      actionId,
      action,
      commitMessage,
      featureBranch,
      filePaths,
    }: {
      actionId: string;
      action: GitStackedAction;
      commitMessage?: string;
      featureBranch?: boolean;
      filePaths?: string[];
    }) => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git action is unavailable.");
      return api.git.runStackedAction({
        actionId,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        cwd: input.cwd,
        action,
        ...(commitMessage ? { commitMessage } : {}),
        ...(featureBranch ? { featureBranch } : {}),
        ...(filePaths ? { filePaths } : {}),
        ...(input.model ? { textGenerationModel: input.model } : {}),
      });
    },
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient, { cwd: input.cwd });
    },
  });
}

export function gitPullMutationOptions(input: { cwd: string | null; queryClient: QueryClient }) {
  return mutationOptions({
    mutationKey: gitMutationKeys.pull(input.cwd),
    mutationFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git pull is unavailable.");
      return api.git.pull({ cwd: input.cwd });
    },
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient, { cwd: input.cwd });
    },
  });
}

export function gitRemoveWorktreeMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationFn: async ({ cwd, path }: { cwd: string; path: string }) => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("Git worktree removal is unavailable.");
      return api.git.removeWorktree({ cwd, path });
    },
    mutationKey: ["git", "mutation", "remove-worktree"] as const,
    onSettled: async (_data, _error, variables) => {
      await invalidateGitQueries(input.queryClient, { cwd: variables.cwd });
    },
  });
}

export function gitPreparePullRequestThreadMutationOptions(input: {
  threadId?: ThreadId | null;
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationFn: async ({ reference, mode }: { reference: string; mode: "local" | "worktree" }) => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Pull request thread preparation is unavailable.");
      return api.git.preparePullRequestThread({
        ...(input.threadId ? { threadId: input.threadId } : {}),
        cwd: input.cwd,
        reference,
        mode,
      });
    },
    mutationKey: gitMutationKeys.preparePullRequestThread(input.cwd),
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient, { cwd: input.cwd });
    },
  });
}

export function worktreesListQueryOptions(projectId: ProjectId | null = null) {
  return queryOptions({
    queryKey: gitQueryKeys.worktrees(projectId),
    queryFn: () => ensureNativeApi().worktrees.list(projectId ? { projectId } : {}),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: false,
  });
}
