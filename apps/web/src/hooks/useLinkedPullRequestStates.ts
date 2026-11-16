import { useQueries } from "@tanstack/react-query";
import { isScratchProject } from "@t3tools/shared/scratchProject";
import { useMemo } from "react";

import { threadPullRequestQueryOptions } from "../lib/gitReactQuery";
import type { LinkedPullRequestState } from "../lib/threadPullRequests";

export interface LinkedPullRequestTarget {
  /** The checkout the lookup runs from; see `linkedPullRequestLookupCwd`. */
  readonly cwd: string | null;
  readonly url: string;
  readonly enabled: boolean;
}

export type LinkedPullRequestStateLookup = (
  cwd: string | null,
  url: string,
) => LinkedPullRequestState | undefined;

/**
 * Links resolve from the project root, not the thread's worktree: a removed worktree must not
 * hide a PR, and threads of one project then share one lookup per PR. Scratch threads have no
 * repository to resolve from.
 */
export function linkedPullRequestLookupCwd(
  project: { readonly cwd: string; readonly kind?: string | undefined } | undefined,
): string | null {
  return project && !isScratchProject(project) ? project.cwd : null;
}

const targetKey = (cwd: string | null, url: string) => `${cwd ?? ""}\0${url}`;

/** Resolved states of linked PRs; a target that has not resolved yet reads as undefined. */
export function useLinkedPullRequestStates(
  targets: ReadonlyArray<LinkedPullRequestTarget>,
): LinkedPullRequestStateLookup {
  const unique = useMemo(() => {
    const byKey = new Map<string, LinkedPullRequestTarget>();
    for (const target of targets) {
      const key = targetKey(target.cwd, target.url);
      const existing = byKey.get(key);
      byKey.set(
        key,
        existing ? { ...existing, enabled: existing.enabled || target.enabled } : target,
      );
    }
    return [...byKey.values()];
  }, [targets]);
  const queries = useQueries({
    queries: unique.map((target) => threadPullRequestQueryOptions(target)),
  });
  // Rows re-render on resolved values only, not on each query object identity.
  const signature = JSON.stringify(
    unique.flatMap((target, index) => {
      const pullRequest = queries[index]?.data?.pullRequest;
      return pullRequest
        ? [[targetKey(target.cwd, target.url), pullRequest.state, pullRequest.title] as const]
        : [];
    }),
  );
  return useMemo(() => {
    const entries = JSON.parse(signature) as Array<
      readonly [string, LinkedPullRequestState["state"], string]
    >;
    const states = new Map(entries.map(([key, state, title]) => [key, { state, title }] as const));
    return (cwd, url) => states.get(targetKey(cwd, url));
  }, [signature]);
}
