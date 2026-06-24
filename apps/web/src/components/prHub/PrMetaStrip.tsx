import { FileDiffIcon, MessageSquareIcon, MessagesSquareIcon } from "lucide-react";
import type { TrackedPullRequest } from "@t3tools/contracts";

import { formatRelativeTimeLabel } from "../../lib/relativeTime";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { attentionVariant, checkIconFor, checkLabel } from "./prHubPresentation";

/**
 * A single metadata chip. `label` is the full accessible description: it is
 * announced to screen readers (via an sr-only span) and shown as the hover
 * tooltip, while the visible `children` (icons + abbreviated values) are
 * aria-hidden so the status never lives only in a hover affordance.
 */
function MetaItem({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={`inline-flex items-center gap-1 ${className ?? "text-muted-foreground"}`}
          />
        }
      >
        <span aria-hidden="true" className="inline-flex items-center gap-1">
          {children}
        </span>
        <span className="sr-only">{label}</span>
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

export function PrMetaStrip({
  pr,
  isSnoozed,
  isIgnored,
}: {
  pr: TrackedPullRequest;
  isSnoozed: boolean;
  isIgnored: boolean;
}) {
  const { Icon: CheckRollupIcon, className: checkClassName } = checkIconFor(pr.checkRollup);
  const relativeTime = formatRelativeTimeLabel(pr.updatedAt);

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
      <Badge variant={attentionVariant(pr)}>{pr.nextAction}</Badge>

      <MetaItem label={checkLabel(pr.checkRollup)} className={checkClassName}>
        <CheckRollupIcon className="size-3.5" />
      </MetaItem>

      <MetaItem label={`${pr.additions} additions · ${pr.deletions} deletions`}>
        <FileDiffIcon className="size-3.5" />
        <span className="tabular-nums">
          <span className="text-success-foreground">+{pr.additions}</span>{" "}
          <span className="text-destructive-foreground">−{pr.deletions}</span>
        </span>
      </MetaItem>

      <MetaItem label={`${pr.changedFiles} changed files`}>
        <span className="tabular-nums">
          {pr.changedFiles} {pr.changedFiles === 1 ? "file" : "files"}
        </span>
      </MetaItem>

      {pr.commentsCount > 0 ? (
        <MetaItem label={`${pr.commentsCount} comments`}>
          <MessageSquareIcon className="size-3.5" />
          <span className="tabular-nums">{pr.commentsCount}</span>
        </MetaItem>
      ) : null}

      {pr.unresolvedThreadCount > 0 ? (
        <MetaItem
          label={`${pr.unresolvedThreadCount} unresolved threads`}
          className="text-warning-foreground"
        >
          <MessagesSquareIcon className="size-3.5" />
          <span className="tabular-nums">{pr.unresolvedThreadCount}</span>
        </MetaItem>
      ) : null}

      <MetaItem
        label={pr.author ? `By ${pr.author} · updated ${relativeTime}` : `Updated ${relativeTime}`}
      >
        <span className="truncate">
          {pr.author ? pr.author : "unknown"} · {relativeTime}
        </span>
      </MetaItem>

      {isSnoozed ? <Badge variant="secondary">Snoozed</Badge> : null}
      {isIgnored ? <Badge variant="secondary">Ignored</Badge> : null}
    </div>
  );
}
