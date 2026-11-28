import { useQueries } from "@tanstack/react-query";
import { isScratchProject } from "@t3tools/shared/scratchProject";
import { useMemo } from "react";
import { hasSafeRelativePathShape } from "@t3tools/shared/checkedInProjectFile";
import { resolvePathLinkTarget } from "../terminal-links";

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

export function linkedRepositoryCwd(
  cwd: string | null,
  repositoryPath?: string,
  externalCwds?: Readonly<Record<string, string>>,
): string | null {
  if (!cwd || !repositoryPath || repositoryPath === ".") return cwd;
  if (repositoryPath.startsWith(".f5-repositories/")) return externalCwds?.[repositoryPath] ?? null;
  return hasSafeRelativePathShape(repositoryPath)
    ? resolvePathLinkTarget("./" + repositoryPath, cwd)
    : null;
}

const targetKey = (cwd: string | null, url: string) => `${cwd ?? ""}\0${url}`;

/**
 * Resolved states of linked PRs; a target that has not resolved yet reads as undefined.
 * `isPending` tells a lookup that is still loading from one that failed or is disabled.
 */
export function useLinkedPullRequestStates(
  targets: ReadonlyArray<LinkedPullRequestTarget>,
): LinkedPullRequestStateLookup & { readonly isPending: (cwd: string | null, url: string) => boolean } {
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
  // A disabled query also reads as pending in React Query, so only enabled lookups count.
  const pendingSignature = JSON.stringify(
    unique.flatMap((target, index) =>
      target.enabled && target.cwd !== null && queries[index]?.status === "pending"
        ? [targetKey(target.cwd, target.url)]
        : [],
    ),
  );
  return useMemo(() => {
    const entries = JSON.parse(signature) as Array<
      readonly [string, LinkedPullRequestState["state"], string]
    >;
    const states = new Map(entries.map(([key, state, title]) => [key, { state, title }] as const));
    const pending = new Set(JSON.parse(pendingSignature) as string[]);
    return Object.assign(
      (cwd: string | null, url: string) => states.get(targetKey(cwd, url)),
      { isPending: (cwd: string | null, url: string) => pending.has(targetKey(cwd, url)) },
    );
  }, [pendingSignature, signature]);
}
