import type {
  GitStatusResult,
  SourceControlPullRequestRef,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import {
  formatSourceControlPullRequestKey,
  parseSourceControlPullRequestUrl,
} from "@t3tools/shared/sourceControl";

export type ThreadPullRequestState = "open" | "closed" | "merged";

/** One PR a thread shows in the sidebar and in View PR. */
export interface ThreadPullRequestItem {
  /** The provider-qualified PR key, or the URL when it does not parse. */
  readonly key: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly repository: string | null;
  readonly state: ThreadPullRequestState;
  /** `branch`: found from the thread's checkout branch; `link`: a stored thread link. */
  readonly source: "branch" | "link";
  /** A stored link exists, so the PR can be unlinked. */
  readonly linked: boolean;
  /** The PR reference, for unlinking and watching; null when the URL does not parse. */
  readonly ref: SourceControlPullRequestRef | null;
}

export interface LinkedPullRequestState {
  readonly state: ThreadPullRequestState;
  readonly title: string;
}

type BranchPullRequest = NonNullable<GitStatusResult["pr"]>;

const STATE_RANK: Record<ThreadPullRequestState, number> = { open: 0, merged: 1, closed: 2 };

/**
 * A thread's PRs: the live branch PR and its stored links, deduped by PR (the branch read
 * wins for state), open first, then newest. Links whose state has not resolved yet are left
 * out, so a row never shows a PR it cannot color.
 */
export function resolveThreadPullRequests(input: {
  readonly branchPr: BranchPullRequest | null;
  readonly links: ReadonlyArray<ThreadPullRequestLink> | undefined;
  readonly linkState: (url: string) => LinkedPullRequestState | undefined;
}): ThreadPullRequestItem[] {
  const items: Array<ThreadPullRequestItem & { readonly recency: number }> = [];
  const branchRef = input.branchPr ? parseSourceControlPullRequestUrl(input.branchPr.url) : null;
  const branchKey = branchRef
    ? formatSourceControlPullRequestKey(branchRef).toLowerCase()
    : (input.branchPr?.url ?? null);
  const links = input.links ?? [];
  const branchLinked =
    branchKey !== null &&
    links.some((link) => formatSourceControlPullRequestKey(link).toLowerCase() === branchKey);
  if (input.branchPr) {
    items.push({
      key: branchRef ? formatSourceControlPullRequestKey(branchRef) : input.branchPr.url,
      number: input.branchPr.number,
      title: input.branchPr.title,
      url: input.branchPr.url,
      repository: branchRef?.repository ?? null,
      state: input.branchPr.state,
      source: "branch",
      linked: branchLinked,
      ref: branchRef,
      recency: -1,
    });
  }
  links.forEach((link, index) => {
    const key = formatSourceControlPullRequestKey(link);
    if (key.toLowerCase() === branchKey) return;
    const resolved = input.linkState(link.url);
    if (!resolved) return;
    items.push({
      key,
      number: link.number,
      title: resolved.title,
      url: link.url,
      repository: link.repository,
      state: resolved.state,
      source: "link",
      linked: true,
      ref: {
        provider: link.provider,
        host: link.host,
        repository: link.repository,
        number: link.number,
      },
      recency: index,
    });
  });
  return items
    .toSorted(
      (left, right) =>
        Number(right.state === "open") - Number(left.state === "open") ||
        left.recency - right.recency,
    )
    .map(({ recency: _recency, ...item }) => item);
}

/** The most actionable state: any open PR, else any merged one, else closed. */
export function summarizeThreadPullRequestState(
  items: ReadonlyArray<ThreadPullRequestItem>,
): ThreadPullRequestState | null {
  let best: ThreadPullRequestState | null = null;
  for (const item of items)
    if (best === null || STATE_RANK[item.state] < STATE_RANK[best]) best = item.state;
  return best;
}

export function threadPullRequestStateLabel(state: ThreadPullRequestState): string {
  return state === "open" ? "open" : state === "merged" ? "merged" : "closed";
}

const STATE_COLOR_CLASS: Record<ThreadPullRequestState, string> = {
  open: "text-success-foreground",
  merged: "text-attention-foreground",
  closed: "text-muted-foreground",
};

export function threadPullRequestStateColorClass(state: ThreadPullRequestState): string {
  return STATE_COLOR_CLASS[state];
}

/** Tooltip lines: one per PR, up to five, then "+N more". */
export function threadPullRequestTooltipLines(
  items: ReadonlyArray<ThreadPullRequestItem>,
): string[] {
  const lines = items
    .slice(0, 5)
    .map((item) => `#${item.number} ${threadPullRequestStateLabel(item.state)} · ${item.title}`);
  if (items.length > 5) lines.push(`+${items.length - 5} more`);
  return lines;
}
