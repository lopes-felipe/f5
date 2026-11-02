import { ProjectId } from "@t3tools/contracts";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

const listBranches = vi.hoisted(() => vi.fn());
vi.mock("../nativeApi", () => ({ ensureNativeApi: () => ({ git: { listBranches } }) }));

import {
  worktreesListQueryOptions,
  gitBranchesQueryOptions,
  gitQueryKeys,
  gitMutationKeys,
  gitPreparePullRequestThreadMutationOptions,
  gitPullMutationOptions,
  gitRunStackedActionMutationOptions,
  gitStatusQueryOptions,
  invalidateGitQueries,
  refreshCheckedOutGitBranch,
} from "./gitReactQuery";
import { rpcQueryContext } from "./rpcQueryContext";

describe("gitMutationKeys", () => {
  it("scopes stacked action keys by cwd", () => {
    expect(gitMutationKeys.runStackedAction("/repo/a")).not.toEqual(
      gitMutationKeys.runStackedAction("/repo/b"),
    );
  });

  it("scopes pull keys by cwd", () => {
    expect(gitMutationKeys.pull("/repo/a")).not.toEqual(gitMutationKeys.pull("/repo/b"));
  });

  it("scopes pull request thread preparation keys by cwd", () => {
    expect(gitMutationKeys.preparePullRequestThread("/repo/a")).not.toEqual(
      gitMutationKeys.preparePullRequestThread("/repo/b"),
    );
  });
});

describe("git mutation options", () => {
  const queryClient = new QueryClient();

  it("attaches cwd-scoped mutation key for runStackedAction", () => {
    const options = gitRunStackedActionMutationOptions({ cwd: "/repo/a", queryClient });
    expect(options.mutationKey).toEqual(gitMutationKeys.runStackedAction("/repo/a"));
  });

  it("attaches cwd-scoped mutation key for pull", () => {
    const options = gitPullMutationOptions({ cwd: "/repo/a", queryClient });
    expect(options.mutationKey).toEqual(gitMutationKeys.pull("/repo/a"));
  });

  it("attaches cwd-scoped mutation key for preparePullRequestThread", () => {
    const options = gitPreparePullRequestThreadMutationOptions({
      cwd: "/repo/a",
      queryClient,
    });
    expect(options.mutationKey).toEqual(gitMutationKeys.preparePullRequestThread("/repo/a"));
  });
});

describe("invalidateGitQueries", () => {
  it("targets only the affected cwd when one is provided", async () => {
    const queryClient = new QueryClient();
    const invalidateQueries = queryClient.invalidateQueries.bind(queryClient);
    const calls: unknown[] = [];
    queryClient.invalidateQueries = ((filters, options) => {
      calls.push(filters);
      return invalidateQueries(filters, options);
    }) as typeof queryClient.invalidateQueries;

    await invalidateGitQueries(queryClient, { cwd: "/repo/a" });

    expect(calls).toEqual([
      { queryKey: gitQueryKeys.status("/repo/a") },
      { queryKey: gitQueryKeys.branches("/repo/a") },
    ]);
  });

  it("falls back to invalidating all git queries when cwd is omitted", async () => {
    const queryClient = new QueryClient();
    const invalidateQueries = queryClient.invalidateQueries.bind(queryClient);
    const calls: unknown[] = [];
    queryClient.invalidateQueries = ((filters, options) => {
      calls.push(filters);
      return invalidateQueries(filters, options);
    }) as typeof queryClient.invalidateQueries;

    await invalidateGitQueries(queryClient);

    expect(calls).toEqual([{ queryKey: gitQueryKeys.all }]);
  });

  it("falls back to invalidating all git queries when cwd is null", async () => {
    const queryClient = new QueryClient();
    const invalidateQueries = queryClient.invalidateQueries.bind(queryClient);
    const calls: unknown[] = [];
    queryClient.invalidateQueries = ((filters, options) => {
      calls.push(filters);
      return invalidateQueries(filters, options);
    }) as typeof queryClient.invalidateQueries;

    await invalidateGitQueries(queryClient, { cwd: null });

    expect(calls).toEqual([{ queryKey: gitQueryKeys.all }]);
  });
});

describe("gitStatusQueryOptions", () => {
  it("keeps local-only status under its own key that cwd invalidation still covers", async () => {
    const local = gitStatusQueryOptions({ cwd: "/repo/a", includeRemote: false });
    const full = gitStatusQueryOptions({ cwd: "/repo/a" });
    expect(local.queryKey).not.toEqual(full.queryKey);
    expect(local.queryKey.slice(0, full.queryKey.length)).toEqual(full.queryKey);

    const queryClient = new QueryClient();
    queryClient.setQueryData(local.queryKey, {
      branch: "main",
      pr: null,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      changeRequest: null,
    });
    await invalidateGitQueries(queryClient, { cwd: "/repo/a" });
    expect(queryClient.getQueryState(local.queryKey)?.isInvalidated).toBe(true);
  });

  it("keeps background refresh behavior enabled by default", () => {
    const options = gitStatusQueryOptions({ cwd: "/repo/a", autoRefresh: true });

    expect(options.refetchInterval).toBe(60_000);
    expect(options.refetchOnWindowFocus).toBe("always");
    expect(options.refetchOnReconnect).toBe("always");
  });

  it("disables interval, focus, and reconnect refreshes when auto-refresh is off", () => {
    const options = gitStatusQueryOptions({ cwd: "/repo/a", autoRefresh: false });

    expect(options.staleTime).toBe(Infinity);
    expect(options.refetchInterval).toBe(false);
    expect(options.refetchOnWindowFocus).toBe(false);
    expect(options.refetchOnReconnect).toBe(false);
  });

  it("preserves sidebar timing overrides when auto-refresh stays enabled", () => {
    const options = gitStatusQueryOptions({
      cwd: "/repo/a",
      autoRefresh: true,
      staleTimeMs: 30_000,
      refetchIntervalMs: 60_000,
    });

    expect(options.staleTime).toBe(30_000);
    expect(options.refetchInterval).toBe(60_000);
    expect(options.refetchOnWindowFocus).toBe("always");
    expect(options.refetchOnReconnect).toBe("always");
  });

  it("lets sidebar rows respect staleTime on focus and reconnect as background reads", () => {
    const options = gitStatusQueryOptions({
      cwd: "/repo/a",
      autoRefresh: true,
      staleTimeMs: 30_000,
      refetchOnFocus: true,
      refetchOnReconnect: true,
      priority: "background",
    });

    expect(options.refetchOnWindowFocus).toBe(true);
    expect(options.refetchOnReconnect).toBe(true);
    expect(options.meta).toEqual({ priority: "background" });
  });

  it("refreshes a loaded status in the background and loads the first one interactively", async () => {
    const queryClient = new QueryClient();
    const options = gitStatusQueryOptions({ cwd: "/repo/a", autoRefresh: true });
    expect(options.meta).toEqual({ priority: "refresh-background" });
    expect(
      rpcQueryContext(
        {
          client: queryClient,
          queryKey: options.queryKey,
          signal: new AbortController().signal,
          meta: options.meta,
        },
        { forwardSignal: false },
      ),
    ).toEqual({ priority: "interactive" });
    queryClient.setQueryData(options.queryKey, {} as never);
    expect(
      rpcQueryContext(
        {
          client: queryClient,
          queryKey: options.queryKey,
          signal: new AbortController().signal,
          meta: options.meta,
        },
        { forwardSignal: false },
      ),
    ).toEqual({ priority: "background" });
  });
});

describe("gitBranchesQueryOptions", () => {
  it("refreshes branches on reconnect without polling and collects idle queries", () => {
    const options = gitBranchesQueryOptions({ cwd: "/repo/a", autoRefresh: true });

    expect(options.refetchInterval).toBe(false);
    expect(options.refetchOnWindowFocus).toBe(false);
    expect(options.refetchOnReconnect).toBe("always");
    expect(options.gcTime).toBe(30_000);
  });

  it("disables branch interval, focus, and reconnect refreshes when auto-refresh is off", () => {
    const options = gitBranchesQueryOptions({ cwd: "/repo/a", autoRefresh: false });

    expect(options.staleTime).toBe(Infinity);
    expect(options.refetchInterval).toBe(false);
    expect(options.refetchOnWindowFocus).toBe(false);
    expect(options.refetchOnReconnect).toBe(false);
  });
});

describe("worktreesListQueryOptions", () => {
  it("scopes inventories by project, only refreshes stale results on focus, and never polls", () => {
    const a = worktreesListQueryOptions(ProjectId.makeUnsafe("a"));
    const b = worktreesListQueryOptions(ProjectId.makeUnsafe("b"));
    expect(a.queryKey).not.toEqual(b.queryKey);
    expect(a.queryKey).not.toEqual(worktreesListQueryOptions().queryKey);
    expect(a.staleTime).toBe(30_000);
    expect(a.refetchOnWindowFocus).toBe(true);
    expect(a.refetchInterval).toBe(false);
  });
});

describe("refreshCheckedOutGitBranch", () => {
  const status = {
    branch: "main",
    hasWorkingTreeChanges: true,
    workingTree: { files: [], insertions: 2, deletions: 1 },
    hasUpstream: true,
    aheadCount: 1,
    behindCount: 3,
    pr: {
      number: 7,
      title: "Main PR",
      url: "https://example.test/pr/7",
      baseBranch: "main",
      headBranch: "main",
      state: "open" as const,
    },
    changeRequest: null,
  };
  const refs = (current: string | null) => ({
    isRepo: true,
    hasOriginRemote: true,
    branches: [
      {
        name: "origin/feature",
        isRemote: true,
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      { name: "main", current: current === "main", isDefault: true, worktreePath: null },
      { name: "feature", current: current === "feature", isDefault: false, worktreePath: null },
    ],
  });
  const moved = (branch: string | null) => ({
    ...status,
    branch,
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    changeRequest: null,
  });
  const statusKey = gitQueryKeys.status("/repo/a");
  const localStatusKey = [...statusKey, "local"];

  it("moves cached statuses to the checked-out branch and clears its remote state", async () => {
    listBranches.mockResolvedValueOnce(refs("feature"));
    const queryClient = new QueryClient();
    queryClient.setQueryData(statusKey, status);
    queryClient.setQueryData(localStatusKey, status);

    await refreshCheckedOutGitBranch(queryClient, "/repo/a");

    expect(listBranches).toHaveBeenLastCalledWith({ cwd: "/repo/a", refresh: true });
    expect(queryClient.getQueryData(statusKey)).toEqual(moved("feature"));
    expect(queryClient.getQueryData(localStatusKey)).toEqual(moved("feature"));
  });

  it("keeps the cached status when the branch did not change", async () => {
    listBranches.mockResolvedValueOnce(refs("main"));
    const queryClient = new QueryClient();
    queryClient.setQueryData(statusKey, status);

    await refreshCheckedOutGitBranch(queryClient, "/repo/a");

    expect(queryClient.getQueryData(statusKey)).toBe(status);
  });

  it("changes nothing when the refs read fails, even with older cached refs", async () => {
    listBranches.mockRejectedValueOnce(new Error("index.lock exists"));
    const queryClient = new QueryClient();
    queryClient.setQueryData(gitQueryKeys.branches("/repo/a"), refs("feature"));
    queryClient.setQueryData(statusKey, status);

    await refreshCheckedOutGitBranch(queryClient, "/repo/a");

    expect(queryClient.getQueryData(statusKey)).toBe(status);
  });

  it("clears the previous branch when HEAD is detached", async () => {
    listBranches.mockResolvedValueOnce(refs(null));
    const queryClient = new QueryClient();
    queryClient.setQueryData(statusKey, status);

    await refreshCheckedOutGitBranch(queryClient, "/repo/a");

    expect(queryClient.getQueryData(statusKey)).toEqual(moved(null));
  });

  it("does not let a status read from before the refresh restore the previous branch", async () => {
    listBranches.mockResolvedValueOnce(refs("feature"));
    const queryClient = new QueryClient();
    queryClient.setQueryData(statusKey, status);
    let resolveStale!: (value: typeof status) => void;
    const staleRead = queryClient
      .fetchQuery({
        queryKey: statusKey,
        queryFn: () => new Promise<typeof status>((resolve) => (resolveStale = resolve)),
        staleTime: 0,
      })
      .catch(() => null);

    await refreshCheckedOutGitBranch(queryClient, "/repo/a");
    resolveStale(status);
    await staleRead;

    expect(queryClient.getQueryData(statusKey)).toEqual(moved("feature"));
  });
});

describe("gitStatusQueryOptions without auto-refresh", () => {
  it("reads local status only, so opening a checkout never fetches the upstream", () => {
    expect(gitStatusQueryOptions({ cwd: "/repo/a", autoRefresh: false }).queryKey).toEqual([
      ...gitQueryKeys.status("/repo/a"),
      "local",
    ]);
    expect(gitStatusQueryOptions({ cwd: "/repo/a", autoRefresh: true }).queryKey).toEqual(
      gitQueryKeys.status("/repo/a"),
    );
  });
});
