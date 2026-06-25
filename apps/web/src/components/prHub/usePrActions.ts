import { useMemo, useState } from "react";
import type { PrHubLocalCheckoutCandidate, TrackedPullRequest } from "@t3tools/contracts";

import { ensureNativeApi } from "../../nativeApi";
import { toastManager } from "../ui/toast";
import { defaultSnoozeUntil, openExternalHttps } from "./prHubPresentation";

export type PrPendingAction =
  | "approve"
  | "comment"
  | "requestChanges"
  | "merge"
  | "markReady"
  | "reRequestReview"
  | "snooze"
  | null;

export type PrMergeMethod = "squash" | "merge" | "rebase";

/** Flags derived from the PR that gate which actions are offered. */
export interface PrActionFlags {
  isAuthor: boolean;
  isOpen: boolean;
  isIgnored: boolean;
  isSnoozed: boolean;
  isIgnoring: boolean;
}

/** Callbacks wired to {@link PrDetailActions} (and any other action surface). */
export interface PrActionHandlers {
  onApprove: () => void;
  onComment: () => void;
  onRequestChanges: () => void;
  onMerge: () => void;
  onMarkReady: () => void;
  onReRequest: () => void;
  onSnooze: () => void;
  onUnsnooze: () => void;
  onIgnore: () => void;
  onOpenInF5: () => void;
  onOpenGitHub: () => void;
}

/** Everything {@link PrActionDialogs} needs to render and run the dialogs. */
export interface PrActionDialogProps {
  pr: TrackedPullRequest;
  pendingAction: PrPendingAction;
  setPendingAction: (action: PrPendingAction) => void;
  dialogTitle: string;
  body: string;
  setBody: (value: string) => void;
  reviewers: string;
  setReviewers: (value: string) => void;
  mergeMethod: PrMergeMethod;
  setMergeMethod: (value: PrMergeMethod) => void;
  snoozeUntil: string;
  setSnoozeUntil: (value: string) => void;
  isRunning: boolean;
  runAction: () => Promise<void>;
  candidatePicker: PrHubLocalCheckoutCandidate[] | null;
  setCandidatePicker: (candidates: PrHubLocalCheckoutCandidate[] | null) => void;
  openInF5: (candidate: PrHubLocalCheckoutCandidate) => Promise<void>;
}

export interface UsePrActionsResult {
  flags: PrActionFlags;
  handlers: PrActionHandlers;
  dialogProps: PrActionDialogProps;
}

/**
 * Owns all of a single PR's mutating state, the action handlers, and the dialog
 * wiring. Shared by every detail surface (Inbox detail pane, Focus card) so the
 * action behaviour lives in exactly one place. Queue advancement is driven by
 * the websocket snapshot dropping the acted-on PR from the list, so there is no
 * explicit completion callback here.
 */
export function usePrActions(pr: TrackedPullRequest): UsePrActionsResult {
  const [pendingAction, setPendingAction] = useState<PrPendingAction>(null);
  const [body, setBody] = useState("");
  const [reviewers, setReviewers] = useState("");
  const [mergeMethod, setMergeMethod] = useState<PrMergeMethod>("squash");
  const [snoozeUntil, setSnoozeUntil] = useState(defaultSnoozeUntil);
  const [isRunning, setIsRunning] = useState(false);
  const [isIgnoring, setIsIgnoring] = useState(false);
  const [candidatePicker, setCandidatePicker] = useState<PrHubLocalCheckoutCandidate[] | null>(
    null,
  );

  const isAuthor = pr.roles.includes("author");
  const isOpen = pr.state === "open";
  const isIgnored = pr.ignoredAt !== null;
  const isSnoozed =
    pr.snoozedUntil !== null &&
    Number.isFinite(new Date(pr.snoozedUntil).getTime()) &&
    new Date(pr.snoozedUntil).getTime() > Date.now();

  const dialogTitle = useMemo(() => {
    switch (pendingAction) {
      case "approve":
        return "Approve pull request";
      case "comment":
        return "Comment on pull request";
      case "requestChanges":
        return "Request changes";
      case "merge":
        return "Merge pull request";
      case "markReady":
        return "Mark ready for review";
      case "reRequestReview":
        return "Re-request review";
      case "snooze":
        return "Snooze pull request";
      default:
        return "";
    }
  }, [pendingAction]);

  const runAction = async () => {
    if (!pendingAction) return;
    setIsRunning(true);
    try {
      const api = ensureNativeApi().prHub;
      if (pendingAction === "approve") {
        await api.approve({ url: pr.url, ...(body.trim() ? { body: body.trim() } : {}) });
      } else if (pendingAction === "comment") {
        await api.comment({ url: pr.url, body: body.trim() });
      } else if (pendingAction === "requestChanges") {
        await api.requestChanges({ url: pr.url, body: body.trim() });
      } else if (pendingAction === "merge") {
        await api.merge({
          url: pr.url,
          method: mergeMethod,
        });
      } else if (pendingAction === "markReady") {
        await api.markReady({ url: pr.url });
      } else if (pendingAction === "reRequestReview") {
        await api.reRequestReview({
          url: pr.url,
          reviewers: reviewers
            .split(",")
            .map((reviewer) => reviewer.trim())
            .filter(Boolean),
        });
      } else if (pendingAction === "snooze") {
        await api.snooze({ key: pr.key, until: new Date(snoozeUntil).toISOString() });
      }
      toastManager.add({ type: "success", title: "Pull request updated" });
      setPendingAction(null);
      setBody("");
      setReviewers("");
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Pull request action failed",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsRunning(false);
    }
  };

  const openInF5 = async (candidate: PrHubLocalCheckoutCandidate) => {
    try {
      const result = await ensureNativeApi().git.preparePullRequestThread({
        cwd: candidate.cwd,
        reference: pr.url,
        mode: "worktree",
      });
      toastManager.add({
        type: "success",
        title: "Pull request prepared",
        description: result.worktreePath ?? result.branch,
      });
      setCandidatePicker(null);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not open pull request in F5",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleOpenInF5 = async () => {
    try {
      const candidates = await ensureNativeApi().prHub.listLocalCheckoutCandidates({ key: pr.key });
      if (candidates.length === 0) {
        toastManager.add({
          type: "info",
          title: "No local clone",
          description: `No local clone of ${pr.repository.nameWithOwner}.`,
        });
        return;
      }
      if (candidates.length === 1) {
        await openInF5(candidates[0]!);
        return;
      }
      setCandidatePicker(candidates);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not resolve local clones",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleIgnore = async () => {
    setIsIgnoring(true);
    try {
      await ensureNativeApi().prHub.ignore({ key: pr.key });
      toastManager.add({ type: "success", title: "Pull request ignored" });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not ignore pull request",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsIgnoring(false);
    }
  };

  const handleUnsnooze = () => {
    void ensureNativeApi().prHub.unsnooze({ key: pr.key });
  };

  return {
    flags: { isAuthor, isOpen, isIgnored, isSnoozed, isIgnoring },
    handlers: {
      onApprove: () => setPendingAction("approve"),
      onComment: () => setPendingAction("comment"),
      onRequestChanges: () => setPendingAction("requestChanges"),
      onMerge: () => setPendingAction("merge"),
      onMarkReady: () => setPendingAction("markReady"),
      onReRequest: () => {
        setReviewers(pr.reviewRequestReviewers.join(", "));
        setPendingAction("reRequestReview");
      },
      onSnooze: () => setPendingAction("snooze"),
      onUnsnooze: handleUnsnooze,
      onIgnore: () => void handleIgnore(),
      onOpenInF5: () => void handleOpenInF5(),
      onOpenGitHub: () => void openExternalHttps(pr.url, "pull request"),
    },
    dialogProps: {
      pr,
      pendingAction,
      setPendingAction,
      dialogTitle,
      body,
      setBody,
      reviewers,
      setReviewers,
      mergeMethod,
      setMergeMethod,
      snoozeUntil,
      setSnoozeUntil,
      isRunning,
      runAction,
      candidatePicker,
      setCandidatePicker,
      openInF5,
    },
  };
}
