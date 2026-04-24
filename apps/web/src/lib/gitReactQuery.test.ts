import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  gitBranchesQueryOptions,
  gitQueryKeys,
  gitMutationKeys,
  gitPreparePullRequestThreadMutationOptions,
  gitPullMutationOptions,
  gitRunStackedActionMutationOptions,
  gitStatusQueryOptions,
  invalidateGitQueries,
} from "./gitReactQuery";

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
});

describe("gitStatusQueryOptions", () => {
  it("keeps background refresh behavior enabled by default", () => {
    const options = gitStatusQueryOptions({ cwd: "/repo/a", autoRefresh: true });

    expect(options.refetchInterval).toBe(15_000);
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
});

describe("gitBranchesQueryOptions", () => {
  it("keeps branch refresh behavior enabled by default", () => {
    const options = gitBranchesQueryOptions({ cwd: "/repo/a", autoRefresh: true });

    expect(options.refetchInterval).toBe(60_000);
    expect(options.refetchOnWindowFocus).toBe(true);
    expect(options.refetchOnReconnect).toBe(true);
  });

  it("disables branch interval, focus, and reconnect refreshes when auto-refresh is off", () => {
    const options = gitBranchesQueryOptions({ cwd: "/repo/a", autoRefresh: false });

    expect(options.staleTime).toBe(Infinity);
    expect(options.refetchInterval).toBe(false);
    expect(options.refetchOnWindowFocus).toBe(false);
    expect(options.refetchOnReconnect).toBe(false);
  });
});
