import type { UpstreamOverview, UpstreamResolvePublicationInput } from "@t3tools/contracts";
import { ChevronRightIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { PAUSE_TEXT, PublicationActions } from "./PublicationBanner";

/**
 * Blocking or actionable problems only, most severe first. Informational
 * notes live in the run status popover.
 */
export function UpstreamAttention(props: {
  readonly overview: UpstreamOverview;
  readonly readOnly: boolean;
  readonly busy: boolean;
  readonly onTakeOver: () => void;
  readonly onAddRemote: () => void;
  readonly onResolvePublication: (action: UpstreamResolvePublicationInput["action"]) => void;
}) {
  const { overview } = props;
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const writerElsewhere = overview.writer.claimed && !overview.writer.managedByThisProfile;
  const paused = overview.publication.pausedReason;
  const items = [
    writerElsewhere && (
      <Alert key="writer" variant="warning" className="py-2">
        <TriangleAlertIcon />
        <AlertDescription className="text-foreground">
          Managed by profile {overview.writer.profileId}
          {overview.writer.hostname ? ` on ${overview.writer.hostname}` : ""}. This page is read-only here.
        </AlertDescription>
        <AlertAction>
          <Button size="xs" variant="outline" disabled={props.busy} onClick={props.onTakeOver}>
            Take over
          </Button>
        </AlertAction>
      </Alert>
    ),
    overview.config && overview.remoteStatus !== "ok" && (
      <Alert key="remote" variant="warning" className="py-2">
        <TriangleAlertIcon />
        <AlertDescription className="text-foreground">
          {overview.remoteStatus === "missing"
            ? `The ${overview.config.remote} remote is missing.`
            : `The ${overview.config.remote} remote points at ${overview.remoteUrl}, but f5.json expects ${overview.config.repository}.`}
        </AlertDescription>
        {overview.remoteStatus === "missing" && (
          <AlertAction>
            <Button size="xs" variant="outline" disabled={props.busy} onClick={props.onAddRemote}>
              Add upstream remote
            </Button>
          </AlertAction>
        )}
      </Alert>
    ),
    paused && paused !== "writer-lost" && (
      <Alert key="publication" variant="warning" className="py-2">
        <TriangleAlertIcon />
        <AlertDescription className="text-foreground">
          Publishing is paused. {PAUSE_TEXT[paused]}
        </AlertDescription>
        <AlertAction>
          <PublicationActions
            publication={overview.publication}
            busy={props.busy || props.readOnly}
            onResolve={props.onResolvePublication}
          />
        </AlertAction>
      </Alert>
    ),
    overview.diagnostics.length > 0 && (
      <Alert key="diagnostics" variant="error" className="py-2">
        <TriangleAlertIcon />
        <AlertDescription className="text-foreground">
          <button
            type="button"
            className="inline-flex items-center gap-1 text-left font-medium"
            aria-expanded={showDiagnostics}
            onClick={() => setShowDiagnostics((value) => !value)}
          >
            <ChevronRightIcon className={cn("size-3.5 transition-transform", showDiagnostics && "rotate-90")} />
            {overview.diagnostics.length} configuration issue{overview.diagnostics.length === 1 ? "" : "s"}
          </button>
          {showDiagnostics && (
            <ul className="list-disc pl-5 text-xs text-muted-foreground">
              {overview.diagnostics.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </AlertDescription>
      </Alert>
    ),
  ].filter(Boolean);
  if (items.length === 0) return null;
  return <div className="space-y-1.5">{items}</div>;
}
