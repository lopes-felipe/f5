import type { UpstreamOverview, UpstreamResolvePublicationInput } from "@t3tools/contracts";
import { GitPullRequestIcon } from "lucide-react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

const PAUSE_TEXT: Record<NonNullable<UpstreamOverview["publication"]["pausedReason"]>, string> = {
  "closed-pr": "The ledger pull request was closed without merging.",
  conflict: "The ledger on the default branch changed in a way these changes cannot apply to.",
  signing: "Signing the ledger commit failed or timed out.",
  auth: "GitHub or the push remote rejected the credentials.",
  "push-rejected": "The push was rejected.",
  "writer-lost": "Another F5 profile took over this repository.",
};

const PHASE_TEXT: Record<UpstreamOverview["publication"]["phase"], string> = {
  idle: "",
  committing: "Committing…",
  pushing: "Pushing…",
  "opening-pr": "Opening pull request…",
};

export function PublicationBanner(props: {
  readonly publication: UpstreamOverview["publication"];
  readonly busy: boolean;
  readonly onResolve: (action: UpstreamResolvePublicationInput["action"]) => void;
}) {
  const { publication } = props;
  const paused = publication.pausedReason;
  if (!paused && publication.unpublishedOps === 0 && publication.prNumber === null) return null;
  const discardLabel = `Discard ${publication.unpublishedOps} change${publication.unpublishedOps === 1 ? "" : "s"}`;
  return (
    <div
      role={paused ? "alert" : "status"}
      className={`flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm ${
        paused ? "border-warning/40 bg-warning/8" : "bg-muted/30"
      }`}
    >
      {publication.prUrl && publication.prNumber !== null && (
        <a
          href={publication.prUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-medium hover:underline"
        >
          <GitPullRequestIcon className="size-3.5" aria-hidden="true" />#{publication.prNumber}
        </a>
      )}
      {publication.prState && <Badge variant="outline">{publication.prState}</Badge>}
      {PHASE_TEXT[publication.phase] && <span>{PHASE_TEXT[publication.phase]}</span>}
      {publication.unpublishedOps > 0 && (
        <span className="text-muted-foreground">
          {publication.unpublishedOps} unpublished change{publication.unpublishedOps === 1 ? "" : "s"}
        </span>
      )}
      {paused && <span className="font-medium">{PAUSE_TEXT[paused]}</span>}
      {publication.lastError && (
        <span className="max-w-full truncate text-xs text-muted-foreground" title={publication.lastError}>
          {publication.lastError}
        </span>
      )}
      <div className="ml-auto flex flex-wrap gap-2">
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
      </div>
    </div>
  );
}
