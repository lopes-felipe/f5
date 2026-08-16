import type { InfiniteData } from "@tanstack/react-query";
import type {
  PrHubDetailResult,
  PrHubReaction,
  PrHubReactionContent,
  PrHubTimelinePage,
  SourceControlPullRequestAction,
  TrackedPullRequest,
} from "@t3tools/contracts";

export interface PrDetailCapability {
  readonly supported: boolean;
  readonly reason: string | null;
}

export function prDetailCapability(
  pr: TrackedPullRequest,
  action: SourceControlPullRequestAction,
): PrDetailCapability {
  const capability = pr.capabilities?.find((candidate) => candidate.action === action);
  if (!capability) {
    return {
      supported: false,
      reason: "This action is unavailable until provider capabilities are refreshed.",
    };
  }
  return capability.supported
    ? { supported: true, reason: null }
    : { supported: false, reason: capability.reason };
}

export const PR_REACTION_LABELS: Readonly<Record<PrHubReactionContent, string>> = {
  "+1": "👍",
  "-1": "👎",
  laugh: "😄",
  hooray: "🎉",
  confused: "😕",
  heart: "❤️",
  rocket: "🚀",
  eyes: "👀",
};

export function setViewerReaction(
  reactions: ReadonlyArray<PrHubReaction>,
  content: PrHubReactionContent,
  reacted: boolean,
): ReadonlyArray<PrHubReaction> {
  const current = reactions.find((reaction) => reaction.content === content);
  if (!current) {
    return reacted
      ? [...reactions, { content, count: 1, viewerHasReacted: true, actors: [] }]
      : reactions;
  }
  if (current.viewerHasReacted === reacted) return reactions;

  const nextCount = Math.max(0, current.count + (reacted ? 1 : -1));
  return reactions.flatMap((reaction) => {
    if (reaction.content !== content) return [reaction];
    if (nextCount === 0) return [];
    return [{ ...reaction, count: nextCount, viewerHasReacted: reacted }];
  });
}

export function updateDetailReaction(
  current: PrHubDetailResult | undefined,
  subjectId: string,
  content: PrHubReactionContent,
  reacted: boolean,
): PrHubDetailResult | undefined {
  if (
    !current ||
    current.detail.providerDetails.provider !== "github" ||
    current.detail.providerDetails.nodeId !== subjectId
  ) {
    return current;
  }
  return {
    ...current,
    detail: {
      ...current.detail,
      reactions: [...setViewerReaction(current.detail.reactions, content, reacted)],
    },
  };
}

export function updateTimelineReaction(
  current: InfiniteData<PrHubTimelinePage, string | undefined> | undefined,
  subjectId: string,
  content: PrHubReactionContent,
  reacted: boolean,
): InfiniteData<PrHubTimelinePage, string | undefined> | undefined {
  if (!current) return current;
  return {
    ...current,
    pages: current.pages.map((page) => ({
      ...page,
      entries: page.entries.map((entry) =>
        entry.type === "comment" && entry.id === subjectId
          ? {
              ...entry,
              reactions: [...setViewerReaction(entry.reactions, content, reacted)],
            }
          : entry,
      ),
    })),
  };
}

export function reconcileTimelineFirstPage(
  current: InfiniteData<PrHubTimelinePage, string | undefined> | undefined,
  firstPage: PrHubTimelinePage,
): InfiniteData<PrHubTimelinePage, string | undefined> {
  if (!current) return { pages: [firstPage], pageParams: [undefined] };
  return {
    pages: [firstPage, ...current.pages.slice(1)],
    pageParams: [undefined, ...current.pageParams.slice(1)],
  };
}
