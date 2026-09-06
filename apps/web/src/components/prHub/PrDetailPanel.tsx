import { prAttentionText } from "@t3tools/shared/prHub";
import { waitingLabel } from "./prHubPresentation";
import { forwardRef, useEffect, useImperativeHandle, useState, type ReactNode } from "react";
import { getPrHubAccountGeneration } from "../../lib/prHubAccount";
import { ensureNativeApi } from "../../nativeApi";
import { GitPullRequestIcon, SparklesIcon } from "lucide-react";
import type { PrHubAdvisory, ThreadId, TrackedPullRequest } from "@t3tools/contracts";

import { formatRelativeTimeLabel, formatAbsoluteTimeLabel } from "../../lib/relativeTime";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { PrActionDialogs } from "./PrActionDialogs";
import { PrAdvisoryInline } from "./PrAdvisoryInline";
import { PrDetailActions } from "./PrDetailActions";
import { PrDetailsTabs, type PrDetailTab } from "./PrDetailsTabs";
import {
  attentionVariant,
  checkIconFor,
  checkLabel,
  mergeableLabel,
  prRowActionVisibility,
  reviewDecisionLabel,
} from "./prHubPresentation";
import { usePrActions } from "./usePrActions";

/** Imperative surface used by Focus mode to fire actions from the keyboard. */
export interface PrDetailHandle {
  /** Label of the contextual primary action, or null when none applies. */
  primaryLabel: string | null;
  triggerPrimary: () => void;
  /** Toggle snooze/unsnooze; no-op when the PR is not actionable. */
  triggerSnooze: () => void;
  /** Ignore the PR; no-op when the PR is not actionable. */
  triggerIgnore: () => void;
}

export interface PrDetailPanelProps {
  pr: TrackedPullRequest;
  advisory?: PrHubAdvisory | undefined;
  isAnalyzingAdvisory?: boolean;
  onAnalyzeAdvisory?: (() => void) | undefined;
  onThreadCreated?: ((threadId: ThreadId) => Promise<void> | void) | undefined;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground/70">{label}</span>
      <span className="min-w-0 truncate text-sm text-foreground">{children}</span>
    </div>
  );
}

function ChipRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground/70">{label}</span>
      {children}
    </div>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">
      {children}
    </span>
  );
}

function stateBadge(pr: TrackedPullRequest): ReactNode {
  if (pr.state === "merged") return <Badge variant="secondary">Merged</Badge>;
  if (pr.state === "closed") return <Badge variant="secondary">Closed</Badge>;
  if (pr.isDraft) return <Badge variant="outline">Draft</Badge>;
  return null;
}

/**
 * The full, rich detail of a single PR — shared verbatim by the Inbox detail
 * pane and the Focus card. Surfaces the next step, a promoted action bar, an
 * overview of everything the snapshot knows, reviewers/assignees/labels, and
 * the AI advisory. Owns nothing but composition: action state lives in
 * {@link usePrActions}.
 */
export const PrDetailPanel = forwardRef<PrDetailHandle, PrDetailPanelProps>(function PrDetailPanel(
  { pr, advisory, isAnalyzingAdvisory = false, onAnalyzeAdvisory, onThreadCreated },
  ref,
) {
  const [activeTab, setActiveTab] = useState<PrDetailTab>("summary");
  const accountGeneration = getPrHubAccountGeneration();
  useEffect(() => {
    if (!accountGeneration) return;
    // A visible detail is seen; merely loading the dashboard never marks the collection.
    const timer = window.setTimeout(() => {
      if (!document.hasFocus() || document.visibilityState !== "visible") return;
      void ensureNativeApi()
        .prHub.markSeen({
          key: pr.key,
          attentionFingerprint: pr.attentionFingerprint,
          accountGeneration,
        })
        .catch(() => {});
    }, 500);
    return () => window.clearTimeout(timer);
  }, [accountGeneration, pr.key, pr.attentionFingerprint]);
  const { flags, handlers, dialogProps, runInF5Label } = usePrActions(pr, {
    advisory,
    onThreadCreated,
  });
  const visibility = prRowActionVisibility(pr, {
    isAuthor: flags.isAuthor,
    isOpen: flags.isOpen,
    isIgnored: flags.isIgnored,
  });

  useImperativeHandle(
    ref,
    () => ({
      primaryLabel: visibility.primary?.label ?? null,
      triggerPrimary: () => {
        switch (visibility.primary?.kind) {
          case "review":
            setActiveTab("files");
            break;
          case "merge":
            handlers.onMerge();
            break;
          case "markReady":
            handlers.onMarkReady();
            break;
          case "reRequest":
            handlers.onReRequest();
            break;
          default:
            break;
        }
      },
      triggerSnooze: () => {
        if (!visibility.canSnooze) return;
        if (flags.isSnoozed) handlers.onUnsnooze();
        else handlers.onSnooze();
      },
      triggerIgnore: () => {
        if (visibility.canIgnore) handlers.onIgnore();
      },
    }),
    [visibility, handlers, flags.isSnoozed],
  );

  const { Icon: CheckIcon, className: checkClassName } = checkIconFor(pr.checkRollup);
  const hasBranches = Boolean(pr.headRefName && pr.baseRefName);
  const showSuggestPrompt =
    !advisory && flags.isOpen && !flags.isIgnored && Boolean(onAnalyzeAdvisory);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex min-w-0 items-start gap-3">
        <GitPullRequestIcon className="mt-1 size-5 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground">
              {pr.repository.nameWithOwner}#{pr.number}
            </span>
            {stateBadge(pr)}
            {flags.isSnoozed ? <Badge variant="secondary">Snoozed</Badge> : null}
            {flags.isIgnored ? <Badge variant="secondary">Ignored</Badge> : null}
          </div>
          <h2 className="min-w-0 text-base font-semibold leading-snug text-foreground">
            {pr.title}
          </h2>
        </div>
      </div>

      <PrDetailActions
        pr={pr}
        isAuthor={flags.isAuthor}
        isOpen={flags.isOpen}
        isIgnored={flags.isIgnored}
        isSnoozed={flags.isSnoozed}
        isIgnoring={flags.isIgnoring}
        isAnalyzingAdvisory={isAnalyzingAdvisory}
        isOpeningInF5={dialogProps.isOpeningInF5}
        runInF5Label={runInF5Label}
        onReview={() => setActiveTab("files")}
        onApprove={handlers.onApprove}
        onComment={handlers.onComment}
        onRequestChanges={handlers.onRequestChanges}
        onMerge={handlers.onMerge}
        onMarkReady={handlers.onMarkReady}
        onReRequest={handlers.onReRequest}
        onSnooze={handlers.onSnooze}
        onUnsnooze={handlers.onUnsnooze}
        onIgnore={handlers.onIgnore}
        {...(onAnalyzeAdvisory ? { onAnalyzeAdvisory } : {})}
        onOpenInF5={handlers.onOpenInF5}
        onRunInF5={handlers.onRunInF5}
        onOpenGitHub={handlers.onOpenGitHub}
      />

      {pr.repositoryArchived ? (
        <p className="px-4 text-sm">Archived repository ? this pull request is read-only.</p>
      ) : null}
      <PrDetailsTabs
        pr={pr}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        summary={
          <>
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={attentionVariant(pr)}>{pr.nextAction}</Badge>
              </div>
              {pr.primaryReason ? (
                <p className="mt-1.5 text-sm text-muted-foreground">{pr.primaryReason}</p>
              ) : null}
            </div>

            <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
              <Fact label="CI">
                <span className={`inline-flex items-center gap-1.5 ${checkClassName}`}>
                  <CheckIcon className="size-3.5" />
                  {checkLabel(pr.checkRollup)}
                </span>
              </Fact>
              <Fact label="Review">{reviewDecisionLabel(pr.reviewDecision)}</Fact>
              <Fact label="Mergeable">
                {mergeableLabel(pr.mergeable)}
                {pr.mergeStateStatus && pr.mergeStateStatus !== "CLEAN" ? (
                  <span className="text-muted-foreground">
                    {" "}
                    · {pr.mergeStateStatus.toLowerCase()}
                  </span>
                ) : null}
              </Fact>
              <Fact label="Changes">
                <span className="tabular-nums">
                  <span className="text-success-foreground">+{pr.additions}</span>{" "}
                  <span className="text-destructive-foreground">−{pr.deletions}</span>
                </span>
              </Fact>
              <Fact label="Files">
                <span className="tabular-nums">{pr.changedFiles}</span>
              </Fact>
              <Fact label="Comments">
                <span className="tabular-nums">{pr.commentsCount}</span>
                {pr.unresolvedThreadCount > 0 ? (
                  <span className="text-warning-foreground">
                    {" "}
                    · {pr.unresolvedThreadCount} unresolved
                  </span>
                ) : null}
              </Fact>
              {hasBranches ? (
                <Fact label="Branch">
                  <span className="font-mono text-xs">
                    {pr.headRefName} → {pr.baseRefName}
                  </span>
                </Fact>
              ) : null}
              {waitingLabel(pr) && pr.waitingSince ? (
                <Fact label="Waiting">
                  <span title={formatAbsoluteTimeLabel(pr.waitingSince)}>{waitingLabel(pr)}</span>
                </Fact>
              ) : null}
              {pr.reasons?.[0] ? (
                <Fact label="Next actor">
                  {pr.reasons[0].actor === "viewer" ? "You" : pr.reasons[0].actor}
                </Fact>
              ) : null}
              {pr.reasons && pr.reasons.length > 0 ? (
                <Fact label="All reasons">
                  <ul className="space-y-1">
                    {pr.reasons.map((reason) => (
                      <li key={reason.code} title={formatAbsoluteTimeLabel(reason.firstObservedAt)}>
                        {
                          prAttentionText(reason.code, pr.actionableUnresolvedThreadCount)
                            .nextAction
                        }
                        {reason.verification === "unverified" ? " (unverified)" : ""}
                        {reason.evidence.length ? (
                          <span className="flex flex-wrap gap-2">
                            {reason.evidence.slice(0, 5).map((evidence, index) => (
                              <a
                                key={evidence.id}
                                href={evidence.url}
                                target="_blank"
                                rel="noreferrer"
                                className="underline"
                              >
                                Evidence {index + 1}
                              </a>
                            ))}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </Fact>
              ) : null}
              <Fact label="Verified">
                {pr.lastVerifiedAt ? (
                  <span title={formatAbsoluteTimeLabel(pr.lastVerifiedAt)}>
                    {formatRelativeTimeLabel(pr.lastVerifiedAt)}
                  </span>
                ) : (
                  "Not verified yet"
                )}
              </Fact>
              {pr.reviewFactsComplete !== true ? (
                <Fact label="Review coverage">
                  {pr.reviewFactsComplete === false
                    ? "Partial ? more review history remains to scan"
                    : "Not verified yet"}
                </Fact>
              ) : null}
              <Fact label="Author">{pr.author ?? "unknown"}</Fact>
              <Fact label="Updated">{formatRelativeTimeLabel(pr.updatedAt)}</Fact>
              <Fact label="Opened">{formatRelativeTimeLabel(pr.createdAt)}</Fact>
            </div>

            {pr.reviewRequestReviewers.length > 0 ? (
              <ChipRow label="Reviewers">
                {pr.reviewRequestReviewers.map((reviewer) => (
                  <Chip key={reviewer}>{reviewer}</Chip>
                ))}
              </ChipRow>
            ) : null}

            {pr.assignees.length > 0 ? (
              <ChipRow label="Assignees">
                {pr.assignees.map((assignee) => (
                  <Chip key={assignee}>{assignee}</Chip>
                ))}
              </ChipRow>
            ) : null}

            {pr.labels.length > 0 ? (
              <ChipRow label="Labels">
                {pr.labels.map((label) => (
                  <Badge key={label} variant="outline" size="sm">
                    {label}
                  </Badge>
                ))}
              </ChipRow>
            ) : null}

            {advisory ? (
              <div className="border-t border-border pt-4">
                <PrAdvisoryInline advisory={advisory} defaultExpanded />
              </div>
            ) : showSuggestPrompt ? (
              <div className="border-t border-border pt-4">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isAnalyzingAdvisory}
                  onClick={() => onAnalyzeAdvisory?.()}
                >
                  <SparklesIcon className={isAnalyzingAdvisory ? "animate-pulse" : ""} />
                  {isAnalyzingAdvisory ? "Analyzing…" : "Get an AI recommendation"}
                </Button>
              </div>
            ) : null}
          </>
        }
      />

      <PrActionDialogs {...dialogProps} />
    </div>
  );
});
