import { useEffect, useRef, type ReactNode } from "react";
import type {
  PrHubAdvisory,
  PullRequestKey,
  ThreadId,
  TrackedPullRequest,
} from "@t3tools/contracts";

import { prQuickActions } from "../../lib/prQuickActions";
import { PrActionDialogs } from "./PrActionDialogs";
import { prRowPrimaryAction, type PrRowAction, type PrRowActionKind } from "./prQueueModel";
import { usePrActions, type PrActionFlags, type PrActionHandlers } from "./usePrActions";

/** A row's next action, or one of the steps every pull request offers. */
export type PrQueueActionKind =
  | PrRowActionKind
  | "primary"
  | "snooze"
  | "ignore"
  | "forge"
  | "close"
  | "reopen";

/** An action asked for outside the host: a row button, or a key press. */
export interface PrQueueActionRequest {
  readonly id: number;
  readonly key: PullRequestKey;
  readonly kind: PrQueueActionKind;
}

export interface PrQueueActionState {
  readonly primary: PrRowAction | null;
  readonly flags: PrActionFlags;
  readonly handlers: PrActionHandlers;
  readonly canMerge: boolean;
  readonly canClose: boolean;
  readonly canReopen: boolean;
  readonly isOpeningInF5: boolean;
  readonly run: (kind: PrQueueActionKind) => void;
}

/**
 * Owns the actions of the selected pull request: their state, their confirmation
 * dialogs, and requests from row buttons and the keyboard. One host is mounted for the
 * selection, never one per row; key it by pull request so its state starts fresh.
 */
export function PrQueueActionHost({
  pr,
  advisory,
  runningThreadId,
  request,
  onRequestHandled,
  onBusyChange,
  onReview,
  onOpenThread,
  children,
}: {
  pr: TrackedPullRequest;
  advisory: PrHubAdvisory | undefined;
  runningThreadId: ThreadId | null;
  request: PrQueueActionRequest | null;
  onRequestHandled: () => void;
  /** Whether a dialog is open or an action is running; the owner keeps the host mounted. */
  onBusyChange?: ((busy: boolean) => void) | undefined;
  /** Opens the pull request's files to review. */
  onReview: (key: PullRequestKey) => void;
  onOpenThread: (threadId: ThreadId) => void;
  children?: ((state: PrQueueActionState) => ReactNode) | undefined;
}) {
  const { flags, handlers, dialogProps } = usePrActions(pr, {
    advisory,
    onThreadCreated: onOpenThread,
  });
  const primary = prRowPrimaryAction(pr, { runningThreadId });
  const quick = prQuickActions(pr);
  const canMerge = flags.isOpen && !flags.isIgnored && flags.isAuthor && quick.includes("merge");
  const canClose = quick.includes("close");
  const canReopen = quick.includes("reopen");

  const run = (kind: PrQueueActionKind) => {
    const step = kind === "primary" ? primary?.kind : kind;
    switch (step) {
      case "review":
        onReview(pr.key);
        break;
      case "fix_ci":
      case "resolve_conflicts":
      case "address_feedback":
        handlers.onRunInF5();
        break;
      case "update_branch":
        handlers.onUpdateBranch();
        break;
      case "merge":
        if (canMerge) handlers.onMerge();
        break;
      case "mark_ready":
        handlers.onMarkReady();
        break;
      case "open_thread":
        if (primary?.threadId) onOpenThread(primary.threadId);
        break;
      case "snooze":
        if (!flags.isOpen || flags.isIgnored) break;
        if (flags.isSnoozed) handlers.onUnsnooze();
        else handlers.onSnooze();
        break;
      case "ignore":
        if (flags.isIgnored) handlers.onRestore();
        else if (flags.isOpen) handlers.onIgnore();
        break;
      case "forge":
        handlers.onOpenGitHub();
        break;
      case "close":
        if (canClose) handlers.onClose();
        break;
      case "reopen":
        if (canReopen) handlers.onReopen();
        break;
      default:
        break;
    }
  };

  const busy =
    dialogProps.pendingAction !== null ||
    dialogProps.isRunning ||
    dialogProps.isOpeningInF5 ||
    Boolean(dialogProps.candidatePicker);
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  const handled = useRef<number | null>(null);
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    if (!request || request.key !== pr.key || handled.current === request.id) return;
    handled.current = request.id;
    onRequestHandled();
    runRef.current(request.kind);
  }, [request, pr.key, onRequestHandled]);

  return (
    <>
      {children?.({
        primary,
        flags,
        handlers,
        canMerge,
        canClose,
        canReopen,
        isOpeningInF5: dialogProps.isOpeningInF5,
        run,
      })}
      <PrActionDialogs {...dialogProps} />
    </>
  );
}
