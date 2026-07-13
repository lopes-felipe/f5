import { useMemo, useState } from "react";
import type {
  PrHubAdvisory,
  PrHubLocalCheckoutCandidate,
  ThreadId,
  TrackedPullRequest,
} from "@t3tools/contracts";

import { ensureNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import { toastManager } from "../ui/toast";
import { createPrF5Thread, prF5RunLabel, resolvePrF5RunKind, type PrF5Intent } from "./prF5Thread";
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
  onRunInF5: () => void;
  onOpenGitHub: () => void;
}

export interface PrF5CandidatePicker {
  candidates: PrHubLocalCheckoutCandidate[];
  intent: PrF5Intent;
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
  candidatePicker: PrF5CandidatePicker | null;
  setCandidatePicker: (picker: PrF5CandidatePicker | null) => void;
  isOpeningInF5: boolean;
  openInF5: (candidate: PrHubLocalCheckoutCandidate, intent: PrF5Intent) => Promise<void>;
}

export interface UsePrActionsResult {
  flags: PrActionFlags;
  handlers: PrActionHandlers;
  dialogProps: PrActionDialogProps;
  runInF5Label: string | null;
}

/**
 * Owns all of a single PR's mutating state, the action handlers, and the dialog
 * wiring. Shared by every detail surface (Inbox detail pane, Focus card) so the
 * action behaviour lives in exactly one place. Queue advancement is driven by
 * the websocket snapshot dropping the acted-on PR from the list, so there is no
 * explicit completion callback here.
 */
export function usePrActions(
  pr: TrackedPullRequest,
  options: {
    advisory?: PrHubAdvisory | undefined;
    onThreadCreated?: ((threadId: ThreadId) => Promise<void> | void) | undefined;
  } = {},
): UsePrActionsResult {
  const projects = useStore((store) => store.projects);
  const [pendingAction, setPendingAction] = useState<PrPendingAction>(null);
  const [body, setBody] = useState("");
  const [reviewers, setReviewers] = useState("");
  const [mergeMethod, setMergeMethod] = useState<PrMergeMethod>("squash");
  const [snoozeUntil, setSnoozeUntil] = useState(defaultSnoozeUntil);
  const [isRunning, setIsRunning] = useState(false);
  const [isIgnoring, setIsIgnoring] = useState(false);
  const [candidatePicker, setCandidatePicker] = useState<PrF5CandidatePicker | null>(null);
  const [isOpeningInF5, setIsOpeningInF5] = useState(false);

  const isAuthor = pr.roles.includes("author");
  const isOpen = pr.state === "open";
  const isIgnored = pr.ignoredAt !== null;
  const isSnoozed =
    pr.snoozedUntil !== null &&
    Number.isFinite(new Date(pr.snoozedUntil).getTime()) &&
    new Date(pr.snoozedUntil).getTime() > Date.now();
  const runKind = resolvePrF5RunKind(pr, options.advisory);
  const runInF5Label = runKind ? prF5RunLabel(runKind) : null;

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

  const openInF5 = async (candidate: PrHubLocalCheckoutCandidate, intent: PrF5Intent) => {
    setIsOpeningInF5(true);
    try {
      const api = ensureNativeApi();
      const project = projects.find((entry) => entry.id === candidate.projectId);
      if (!project) {
        throw new Error("The selected F5 project no longer exists. Refresh PR Hub and retry.");
      }
      const serverConfig = await api.server.getConfig();
      const result = await createPrF5Thread({
        api,
        candidate,
        pr,
        advisory: options.advisory,
        intent,
        preferredModel: project.model,
        providers: serverConfig.providers,
      });
      toastManager.add({
        type: "success",
        title: intent === "open" ? "Pull request opened in F5" : `${prF5RunLabel(intent)} started`,
        description: result.worktreePath,
      });
      setCandidatePicker(null);
      await options.onThreadCreated?.(result.threadId);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: intent === "open" ? "Could not open pull request in F5" : "Could not start F5 run",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsOpeningInF5(false);
    }
  };

  const handleOpenInF5 = async (intent: PrF5Intent) => {
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
        await openInF5(candidates[0]!, intent);
        return;
      }
      setCandidatePicker({ candidates, intent });
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
      onOpenInF5: () => void handleOpenInF5("open"),
      onRunInF5: () => {
        if (runKind) void handleOpenInF5(runKind);
      },
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
      isOpeningInF5,
      openInF5,
    },
    runInF5Label,
  };
}
