import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatSourceControlPullRequestKey } from "@t3tools/shared/sourceControl";
import type { PrHubPeek } from "@t3tools/contracts";
import { AlertTriangleIcon, CheckIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useExternalLinkContextMenu } from "../../hooks/useExternalLinkContextMenu";
import { OpenLinkThread, useOpenLink } from "../../hooks/useOpenLink";
import { prHubPeekQueryOptions } from "../../lib/prHubReactQuery";
import { parsePullRequestReference } from "../../lib/pullRequestReference";
import { formatRelativeTimeLabel } from "../../lib/relativeTime";
import { useRightPanelStore } from "../../rightPanelStore";
import { OpenLinkAnchor } from "../OpenLinkAnchor";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { PreviewCard, PreviewCardTrigger, PreviewCardPopup } from "../ui/preview-card";
import { checkIconFor, checkLabel, reviewDecisionLabel, mergeableLabel } from "./prHubPresentation";

function StatusChips({
  status,
  isOpen,
}: {
  status: NonNullable<PrHubPeek["status"]>;
  isOpen: boolean;
}) {
  const { Icon, className } = checkIconFor(status.checkRollup);
  const chip = (label: string, children: ReactNode) => (
    <Badge variant="secondary" size="sm" title={label} aria-label={label}>
      {children}
    </Badge>
  );
  return (
    <div className="flex flex-wrap gap-1">
      {isOpen &&
        chip(
          checkLabel(status.checkRollup),
          <>
            <Icon className={className} />
            CI
          </>,
        )}
      {status.reviewDecision !== "none" &&
        chip(
          reviewDecisionLabel(status.reviewDecision),
          reviewDecisionLabel(status.reviewDecision),
        )}
      {status.unresolvedThreadCount > 0 &&
        chip(
          String(status.unresolvedThreadCount) + " unresolved threads",
          <>
            <AlertTriangleIcon className="text-warning-foreground" />
            {status.unresolvedThreadCount}
          </>,
        )}
      {isOpen &&
        status.mergeable !== "unknown" &&
        chip(mergeableLabel(status.mergeable), mergeableLabel(status.mergeable))}
    </div>
  );
}

function PreviewFacts({ value }: { value: PrHubPeek }) {
  const time =
    value.state === "merged" && value.mergedAt
      ? { label: "merged", date: value.mergedAt }
      : value.updatedAt
        ? { label: "updated", date: value.updatedAt }
        : value.createdAt
          ? { label: "opened", date: value.createdAt }
          : null;
  return (
    <>
      <strong className="line-clamp-2 text-sm font-medium leading-snug">{value.title}</strong>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {value.author && (
          <span className="inline-flex min-w-0 items-center gap-1">
            <span
              aria-hidden
              className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-2xs"
            >
              {value.author[0]?.toUpperCase()}
            </span>
            <span className="max-w-28 truncate">{value.author}</span>
          </span>
        )}
        {time && (
          <span title={time.date}>
            {time.label} {formatRelativeTimeLabel(time.date)}
          </span>
        )}
        {value.additions !== null && value.deletions !== null && (
          <span className="ml-auto font-mono text-2xs">
            <span className="text-success-foreground">+{value.additions}</span>{" "}
            <span className="text-destructive-foreground">−{value.deletions}</span>
          </span>
        )}
      </div>
      {value.status && <StatusChips status={value.status} isOpen={value.state === "open"} />}
    </>
  );
}

function previewError(error: unknown, host: string): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  switch (code) {
    case "PrHubAccountRequired":
      return "Connect a " + host + " account in PR Hub to preview this pull request.";
    case "PrHubAccountMismatch":
      return "Select the account for this repository in PR Hub to preview this pull request.";
    case "PrHubAccountChanged":
      return "Refresh PR Hub and select an account to preview this pull request.";
    case "PrHubAccessDenied":
      return "Your account does not have access to this pull request.";
    default:
      return "Preview unavailable";
  }
}

export function PrLinkPreview({ url, children }: { url: string; children: ReactNode }) {
  const contextMenu = useExternalLinkContextMenu();
  const openLink = useOpenLink();
  const thread = useContext(OpenLinkThread);
  const [open, setOpen] = useState(false);
  const client = useQueryClient();
  const options = prHubPeekQueryOptions(url);
  const query = useQuery({ ...options, enabled: open });
  const value = query.data;
  const actionUrl = value?.url ?? url;
  const ref = value ?? parsePullRequestReference(url);
  const host = ref?.host;
  const { copyToClipboard, isCopied } = useCopyToClipboard({ timeout: 1500 });
  const prefetch = () => {
    void client.prefetchQuery(options);
  };
  const prefetchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelPrefetch = () => {
    clearTimeout(prefetchTimer.current);
    prefetchTimer.current = undefined;
  };
  useEffect(() => cancelPrefetch, [url]);
  const state = value?.state === "open" && value.isDraft ? "draft" : value?.state;
  return (
    <PreviewCard
      open={open}
      onOpenChange={(next, details) => {
        // Clicking the link keeps its normal navigation behavior.
        if (details.reason === "trigger-press") return;
        setOpen(next);
      }}
    >
      <PreviewCardTrigger
        render={<OpenLinkAnchor />}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onPointerEnter={() => {
          cancelPrefetch();
          prefetchTimer.current = setTimeout(prefetch, 150);
        }}
        onPointerLeave={cancelPrefetch}
        onFocus={(event) => {
          if (event.currentTarget.matches(":focus-visible")) {
            cancelPrefetch();
            prefetch();
            setOpen(true);
          }
        }}
        onContextMenu={(event) => contextMenu(event, url)}
      >
        {children}
      </PreviewCardTrigger>
      <PreviewCardPopup
        aria-label="Pull request preview"
        className="flex w-[300px] max-w-[calc(100vw-16px)] flex-col gap-2 p-3 text-sm"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs text-muted-foreground">
            {ref ? ref.repository + " #" + ref.number : "Pull request preview"}
          </span>
          {state ? (
            <Badge
              size="sm"
              variant={
                state === "open"
                  ? "success"
                  : state === "merged"
                    ? "info"
                    : state === "draft"
                      ? "outline"
                      : "secondary"
              }
              className={state === "draft" ? "text-muted-foreground" : undefined}
            >
              {state[0]!.toUpperCase() + state.slice(1)}
            </Badge>
          ) : !query.isError && query.isPending ? (
            <span className="h-4 w-10 animate-pulse rounded bg-muted" />
          ) : null}
        </div>
        {value ? (
          <PreviewFacts value={value} />
        ) : query.isError || !query.isPending ? (
          <p className="text-xs text-muted-foreground">
            {previewError(query.error, host ?? "forge")}
          </p>
        ) : (
          <div aria-label="Loading pull request" className="animate-pulse space-y-2">
            <div className="h-4 rounded bg-muted" />
            <div className="h-4 w-3/4 rounded bg-muted" />
            <div className="h-3 w-2/3 rounded bg-muted" />
          </div>
        )}
        <div className="flex items-center gap-1 border-t pt-2">
          {thread && ref && (
            <Button
              size="xs"
              onClick={() => {
                useRightPanelStore.getState().openPullRequest(thread, {
                  key: formatSourceControlPullRequestKey(ref),
                  url: actionUrl,
                });
                setOpen(false);
              }}
            >
              Open in F5
            </Button>
          )}
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            aria-label={isCopied ? "Copied link" : "Copy link"}
            onClick={() => copyToClipboard(actionUrl, undefined)}
          >
            {isCopied ? <CheckIcon /> : <CopyIcon />}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            aria-label={host ? "Open on " + host : "Open on forge"}
            onClick={() => {
              void openLink(actionUrl, { external: true });
            }}
          >
            <ExternalLinkIcon />
          </Button>
        </div>
      </PreviewCardPopup>
    </PreviewCard>
  );
}
