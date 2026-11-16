import type { UpstreamOverview, UpstreamResolvePublicationInput } from "@t3tools/contracts";
import { GitPullRequestIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ledgerChipLabel } from "./upstreamPage.logic";

type Publication = UpstreamOverview["publication"];
type ResolveAction = UpstreamResolvePublicationInput["action"];

export const PAUSE_TEXT: Record<NonNullable<Publication["pausedReason"]>, string> = {
  "closed-pr": "The ledger pull request was closed without merging.",
  conflict: "The ledger on the default branch changed in a way these changes cannot apply to.",
  signing: "Signing the ledger commit failed or timed out.",
  auth: "GitHub or the push remote rejected the credentials.",
  "push-rejected": "The push was rejected.",
  "writer-lost": "Another F5 profile took over this repository.",
};

const PHASE_TEXT: Record<Publication["phase"], string> = {
  idle: "",
  committing: "Committing…",
  pushing: "Pushing…",
  "opening-pr": "Opening pull request…",
};

/** The buttons that resolve a paused publication. */
export function PublicationActions(props: {
  readonly publication: Publication;
  readonly busy: boolean;
  readonly onResolve: (action: ResolveAction) => void;
}) {
  const { publication } = props;
  const paused = publication.pausedReason;
  const discardLabel = `Discard ${publication.unpublishedOps} change${publication.unpublishedOps === 1 ? "" : "s"}`;
  return (
    <>
      {(paused === "auth" || paused === "signing" || paused === "push-rejected") && (
        <Button size="xs" variant="outline" disabled={props.busy} onClick={() => props.onResolve("retry")}>
          Retry publish
        </Button>
      )}
      {paused === "closed-pr" && (
        <Button size="xs" variant="outline" disabled={props.busy} onClick={() => props.onResolve("republish")}>
          Re-publish on a new PR
        </Button>
      )}
      {(paused === "closed-pr" || paused === "conflict") && publication.unpublishedOps > 0 && (
        <Button size="xs" variant="destructive" disabled={props.busy} onClick={() => props.onResolve("discard")}>
          {paused === "conflict" ? "Discard unpublished changes and resync" : discardLabel}
        </Button>
      )}
    </>
  );
}

/** The ledger chip in the page header; its popover holds the publication state and actions. */
export function LedgerChip(props: {
  readonly publication: Publication;
  readonly busy: boolean;
  readonly onResolve: (action: ResolveAction) => void;
}) {
  const { publication } = props;
  const label = ledgerChipLabel(publication);
  if (!label) return null;
  const paused = publication.pausedReason;
  const phase = PHASE_TEXT[publication.phase];
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            size="xs"
            variant="outline"
            className={cn("tabular-nums", paused && "border-warning/40 bg-warning/8 text-warning-foreground")}
          />
        }
      >
        <GitPullRequestIcon aria-hidden="true" />
        {label}
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-80 space-y-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">Ledger pull request</span>
          {publication.prUrl && publication.prNumber !== null ? (
            <a href={publication.prUrl} target="_blank" rel="noreferrer" className="hover:underline">
              #{publication.prNumber}
            </a>
          ) : (
            <span className="text-muted-foreground">not opened yet</span>
          )}
          {publication.prState && <Badge variant="outline">{publication.prState}</Badge>}
        </div>
        <p className="text-muted-foreground">
          {publication.unpublishedOps > 0
            ? `${publication.unpublishedOps} change${publication.unpublishedOps === 1 ? "" : "s"} not published yet. F5 publishes them to the rolling ledger pull request.`
            : "Everything is published."}
        </p>
        {phase && <p>{phase}</p>}
        {paused && <p className="font-medium text-warning-foreground">{PAUSE_TEXT[paused]}</p>}
        {publication.lastError && (
          <p className="break-words text-xs text-muted-foreground">{publication.lastError}</p>
        )}
        <div className="flex flex-wrap gap-2">
          <PublicationActions publication={publication} busy={props.busy} onResolve={props.onResolve} />
        </div>
      </PopoverPopup>
    </Popover>
  );
}
