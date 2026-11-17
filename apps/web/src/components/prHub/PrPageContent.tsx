import { useContext, useEffect, useRef, useState } from "react";
import { CopyIcon } from "lucide-react";
import type { PrHubAdvisory, ThreadId, TrackedPullRequest } from "@t3tools/contracts";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { OpenLinkThread } from "../../hooks/useOpenLink";
import { prQuickActions, type PrQuickActionRequest } from "../../lib/prQuickActions";
import { formatAbsoluteTimeLabel, formatRelativeTimeLabel } from "../../lib/relativeTime";
import { cn } from "../../lib/utils";
import {
  useThreadPullRequestWatches,
  WATCH_ERROR_MESSAGE,
} from "../pullRequests/threadPullRequestActions";
import { Badge } from "../ui/badge";
import { toastManager } from "../ui/toast";
import { PrActionDialogs } from "./PrActionDialogs";
import { PrAuthorLink } from "./PrAuthorLink";
import { PrDetailsTabs, type PrDetailTab } from "./PrDetailsTabs";
import { PrPageActions } from "./PrPageActions";
import { prPageActionAvailability, prRowPrimaryAction } from "./prQueueModel";
import { usePrActions } from "./usePrActions";
import { usePrMarkSeen } from "./usePrMarkSeen";

export interface PrPageContentProps {
  pr: TrackedPullRequest;
  /**
   * The narrow panel next to a thread: a tighter header, and confirmations take the place
   * of the tabs instead of covering the conversation with a dialog.
   */
  compact?: boolean;
  advisory?: PrHubAdvisory | undefined;
  isAnalyzingAdvisory?: boolean;
  onAnalyzeAdvisory?: (() => void) | undefined;
  onThreadCreated?: ((threadId: ThreadId) => Promise<void> | void) | undefined;
  /** Opens a linked thread; without it linked threads are not offered. */
  onOpenThread?: ((threadId: ThreadId) => void) | undefined;
  /** A linked thread that is already working on this pull request. */
  runningThreadId?: ThreadId | null | undefined;
  /** The open tab when the caller keeps it (the queue keeps it in the URL). */
  tab?: PrDetailTab | undefined;
  onTabChange?: ((tab: PrDetailTab) => void) | undefined;
  initialAction?: PrQuickActionRequest | undefined;
  onInitialActionHandled?: (() => void) | undefined;
  /** Opens the reviewer editor at once, for "Request reviewers" pressed in the peek. */
  defaultEditingReviewers?: boolean | undefined;
}

function StateBadge({ pr }: { pr: TrackedPullRequest }) {
  if (pr.state === "merged") return <Badge variant="secondary">Merged</Badge>;
  if (pr.state === "closed") return <Badge variant="secondary">Closed</Badge>;
  if (pr.isDraft) return <Badge variant="outline">Draft</Badge>;
  return <Badge variant="success">Open</Badge>;
}

/**
 * A pull request in full: header, one action bar and the tabs. The queue shows it as the
 * pull request page; a thread shows it, compact, in its side panel. Action state lives in
 * {@link usePrActions}; this component only composes.
 */
export function PrPageContent({
  pr,
  compact = false,
  advisory,
  isAnalyzingAdvisory = false,
  onAnalyzeAdvisory,
  onThreadCreated,
  onOpenThread,
  runningThreadId,
  tab,
  onTabChange,
  initialAction,
  onInitialActionHandled,
  defaultEditingReviewers,
}: PrPageContentProps) {
  const [localTab, setLocalTab] = useState<PrDetailTab>("overview");
  const activeTab = tab ?? localTab;
  const setActiveTab = (next: PrDetailTab) => {
    setLocalTab(next);
    onTabChange?.(next);
  };
  usePrMarkSeen(pr);
  const { flags, handlers, dialogProps, runInF5Label } = usePrActions(pr, {
    advisory,
    onThreadCreated,
  });

  const handledQuickAction = useRef<string | null>(null);
  useEffect(() => {
    if (!initialAction || handledQuickAction.current === initialAction.id) return;
    handledQuickAction.current = initialAction.id;
    onInitialActionHandled?.();
    if (
      !prQuickActions(pr).includes(initialAction.kind) ||
      (initialAction.kind === "merge" && !prPageActionAvailability(pr).canMerge)
    ) {
      toastManager.add({
        type: "info",
        title: "This PR action is no longer available. Refresh its state.",
      });
      return;
    }
    if (initialAction.kind === "merge") handlers.onMerge();
    else if (initialAction.kind === "ready") handlers.onMarkReady();
    else dialogProps.setPendingAction(initialAction.kind);
  }, [initialAction, pr, handlers, dialogProps, onInitialActionHandled]);

  const primary = prRowPrimaryAction(pr, {
    runningThreadId: onOpenThread ? runningThreadId : null,
  });
  const onPrimary = () => {
    switch (primary?.kind) {
      case "review":
        setActiveTab("files");
        break;
      case "fix_ci":
        handlers.onFixCi();
        break;
      case "resolve_conflicts":
      case "address_feedback":
        handlers.onRunInF5();
        break;
      case "update_branch":
        handlers.onUpdateBranch();
        break;
      case "merge":
        handlers.onMerge();
        break;
      case "mark_ready":
        handlers.onMarkReady();
        break;
      case "open_thread":
        if (primary.threadId) onOpenThread?.(primary.threadId);
        break;
      default:
        break;
    }
  };

  // Inside a thread, that thread can follow this pull request and wake up on its changes.
  const threadId = useContext(OpenLinkThread) ?? null;
  const watches = useThreadPullRequestWatches(threadId);
  const watched = watches.isWatched(pr.key);
  const watch = threadId
    ? {
        watched,
        busy: watches.busy,
        onToggle: () => {
          void watches.watchAction(pr.key, watched).then((done) => {
            if (!done) toastManager.add({ type: "error", title: WATCH_ERROR_MESSAGE });
          });
        },
      }
    : undefined;

  const copyBranch = () => {
    void writeTextToClipboard(pr.headRefName ?? "").then(
      () => toastManager.add({ type: "success", title: "Branch name copied" }),
      () => toastManager.add({ type: "error", title: "Could not copy the branch name" }),
    );
  };

  return (
    <div
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-col [&>*:not([data-pr-detail-tabs]):not([data-pr-inline-confirmation])]:shrink-0",
        compact ? "gap-3" : "gap-4",
      )}
    >
      <header className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <StateBadge pr={pr} />
          <span className="font-mono text-xs text-muted-foreground">
            {pr.repository.nameWithOwner}#{pr.number}
          </span>
          {flags.isSnoozed ? <Badge variant="secondary">Snoozed</Badge> : null}
          {flags.isIgnored ? <Badge variant="secondary">Ignored</Badge> : null}
        </div>
        <h2
          className={cn(
            "min-w-0 font-semibold leading-snug text-foreground",
            compact ? "text-base" : "text-lg",
          )}
        >
          {pr.title}
        </h2>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {pr.author ? <PrAuthorLink prUrl={pr.url} login={pr.author} /> : null}
          {pr.headRefName && pr.baseRefName ? (
            <button
              type="button"
              title="Copy the branch name"
              aria-label={`Copy branch name ${pr.headRefName}`}
              className="inline-flex min-w-0 items-center gap-1 rounded-sm font-mono hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              onClick={copyBranch}
            >
              <span className="truncate">
                {pr.headRefName} → {pr.baseRefName}
              </span>
              <CopyIcon aria-hidden="true" className="size-3 shrink-0" />
            </button>
          ) : null}
          <span className="tabular-nums">
            <span className="text-success-foreground">+{pr.additions}</span>{" "}
            <span className="text-destructive-foreground">−{pr.deletions}</span>
            {" · "}
            {pr.changedFiles} {pr.changedFiles === 1 ? "file" : "files"}
          </span>
          <span title={formatAbsoluteTimeLabel(pr.updatedAt)}>
            Updated {formatRelativeTimeLabel(pr.updatedAt)}
          </span>
        </div>
      </header>

      <PrPageActions
        pr={pr}
        primary={primary}
        flags={flags}
        handlers={handlers}
        mergeMethod={dialogProps.mergeMethod}
        mergeMethods={dialogProps.allowedMergeMethods}
        onMergeMethodChange={dialogProps.setMergeMethod}
        isOpeningInF5={dialogProps.isOpeningInF5}
        runInF5Label={runInF5Label}
        onPrimary={onPrimary}
        isAnalyzingAdvisory={isAnalyzingAdvisory}
        onAnalyzeAdvisory={onAnalyzeAdvisory}
        watch={watch}
      />

      <PrDetailsTabs
        pr={pr}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        overview={{
          advisory,
          isAnalyzingAdvisory,
          onAnalyzeAdvisory,
          onOpenThread,
          onChecklistStep: (kind) => {
            if (kind === "update_branch") handlers.onUpdateBranch();
            else if (kind === "rerun_checks") handlers.onRerunChecks();
            else if (kind === "fix_ci") handlers.onFixCi();
            else handlers.onRunInF5();
          },
          defaultEditingReviewers,
        }}
        checks={{
          onRerun: handlers.onRerunChecks,
          onFixCi: handlers.onFixCi,
          isStartingFix: dialogProps.isOpeningInF5,
        }}
      />

      <PrActionDialogs {...dialogProps} confirmationMode={compact ? "inline" : "dialog"} />
    </div>
  );
}
