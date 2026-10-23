import { memo, useState } from "react";
import {
  buildCollapsedProposedPlanPreviewMarkdown,
  proposedPlanTitle,
  stripDisplayedPlanMarkdown,
} from "../../proposedPlan";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { MarkdownArtifactActions } from "./MarkdownArtifactActions";

export const ProposedPlanCard = memo(function ProposedPlanCard({
  planMarkdown,
  cwd,
  workspaceRoot,
  forceExpanded = false,
}: {
  planMarkdown: string;
  cwd: string | undefined;
  workspaceRoot: string | undefined;
  forceExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const showExpanded = expanded || forceExpanded;
  const title = proposedPlanTitle(planMarkdown) ?? "Proposed plan";
  const lineCount = planMarkdown.split("\n").length;
  const canCollapse = planMarkdown.length > 900 || lineCount > 20;
  const displayedPlanMarkdown = stripDisplayedPlanMarkdown(planMarkdown);
  const collapsedPreview = canCollapse
    ? buildCollapsedProposedPlanPreviewMarkdown(planMarkdown, { maxLines: 10 })
    : null;

  return (
    <div className="rounded-3xl border border-border/80 bg-card/70 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="secondary" data-thread-find-ignore>
            Plan
          </Badge>
          <p className="truncate text-sm font-medium text-foreground">{title}</p>
        </div>
        <MarkdownArtifactActions
          markdown={planMarkdown}
          workspaceRoot={workspaceRoot}
          artifactNoun="plan"
        />
      </div>
      <div className="mt-4">
        <div
          className={cn("relative", canCollapse && !showExpanded && "max-h-104 overflow-hidden")}
        >
          {canCollapse && !showExpanded ? (
            <ChatMarkdown text={collapsedPreview ?? ""} cwd={cwd} isStreaming={false} />
          ) : (
            <ChatMarkdown text={displayedPlanMarkdown} cwd={cwd} isStreaming={false} />
          )}
          {canCollapse && !showExpanded ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-linear-to-t from-card/95 via-card/80 to-transparent" />
          ) : null}
        </div>
        {canCollapse && !forceExpanded ? (
          <div className="mt-4 flex justify-center">
            <Button
              size="sm"
              variant="outline"
              data-scroll-anchor-ignore
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "Collapse plan" : "Expand plan"}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
});
