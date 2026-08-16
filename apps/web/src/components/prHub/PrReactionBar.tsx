import type { PrHubReaction, PrHubReactionContent, PullRequestKey } from "@t3tools/contracts";

import { Button } from "../ui/button";
import { PR_REACTION_LABELS } from "./prDetails.logic";

const REACTION_ORDER = Object.keys(PR_REACTION_LABELS) as PrHubReactionContent[];

export function PrReactionBar({
  prKey,
  subjectId,
  reactions,
  disabledReason,
  isPending,
  onSetReaction,
}: {
  prKey: PullRequestKey;
  subjectId: string | null;
  reactions: ReadonlyArray<PrHubReaction>;
  disabledReason: string | null;
  isPending: boolean;
  onSetReaction: (input: {
    readonly key: PullRequestKey;
    readonly subjectId: string;
    readonly content: PrHubReactionContent;
    readonly reacted: boolean;
  }) => void;
}) {
  if (!subjectId && reactions.length === 0) return null;
  const visible = REACTION_ORDER.filter(
    (content) => reactions.some((reaction) => reaction.content === content) || subjectId !== null,
  );

  return (
    <div className="flex flex-wrap items-center gap-1" aria-label="Reactions">
      {visible.map((content) => {
        const reaction = reactions.find((candidate) => candidate.content === content);
        const reacted = reaction?.viewerHasReacted ?? false;
        return (
          <Button
            key={content}
            size="xs"
            variant={reacted ? "secondary" : "outline"}
            aria-pressed={reacted}
            aria-label={`${reacted ? "Remove" : "Add"} ${content} reaction`}
            title={disabledReason ?? undefined}
            disabled={!subjectId || Boolean(disabledReason) || isPending}
            onClick={() => {
              if (!subjectId) return;
              onSetReaction({ key: prKey, subjectId, content, reacted: !reacted });
            }}
          >
            <span aria-hidden="true">{PR_REACTION_LABELS[content]}</span>
            {reaction?.count ? <span className="tabular-nums">{reaction.count}</span> : null}
          </Button>
        );
      })}
    </div>
  );
}
