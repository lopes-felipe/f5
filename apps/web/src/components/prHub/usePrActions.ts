import { useAppSettings } from "../../appSettings";
import { registerProjectFromPath, waitForRegisteredProject } from "../../lib/registerProject";
import { getPrHubAccountGeneration } from "../../lib/prHubAccount";
import { isPrSnoozed } from "./prHubPresentation";
import { useEffect, useMemo, useState, useRef } from "react";
import type {
  PrHubAdvisory,
  PrHubComparisonIdentity,
  PrHubResolvedCheckout,
  ThreadId,
  TrackedPullRequest,
} from "@t3tools/contracts";

import { ensureNativeApi } from "../../nativeApi";
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
  onAcknowledge: () => void;
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
  candidates: PrHubResolvedCheckout[];
  intent: PrF5Intent;
  error?: string;
}

/** Everything {@link PrActionDialogs} needs to render and run the dialogs. */
export interface PrActionDialogProps {
  pr: TrackedPullRequest;
  pendingAction: PrPendingAction;
  setPendingAction: (action: PrPendingAction) => void;
  dialogTitle: string;
  reviewers: string;
  setReviewers: (value: string) => void;
  mergeMethod: PrMergeMethod;
  mergeComparison: PrHubComparisonIdentity | null;
  mergeComparisonError: string | null;
  reloadMergeComparison: () => void;
  setMergeMethod: (value: PrMergeMethod) => void;
  snoozeUntil: string;
  setSnoozeUntil: (value: string) => void;
  isRunning: boolean;
  runAction: () => Promise<void>;
  candidatePicker: PrF5CandidatePicker | null;
  setCandidatePicker: (picker: PrF5CandidatePicker | null) => void;
  isOpeningInF5: boolean;
  selectFolder: (path?: string) => Promise<void>;
  openInF5: (candidate: PrHubResolvedCheckout, intent: PrF5Intent) => Promise<void>;
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
  const { settings } = useAppSettings();
  const busy = useRef(false);
  const [pendingAction, setPendingAction] = useState<PrPendingAction>(null);
  const [reviewers, setReviewers] = useState("");
  const [mergeMethod, setMergeMethod] = useState<PrMergeMethod>("squash");
  const [mergeComparison, setMergeComparison] = useState<PrHubComparisonIdentity | null>(null);
  const [mergeComparisonError, setMergeComparisonError] = useState<string | null>(null);
  const [mergeReadAttempt, setMergeReadAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setMergeComparison(null);
    setMergeComparisonError(null);
    if (pendingAction === "merge")
      void ensureNativeApi()
        .prHub.getFiles({ key: pr.key, mode: "force" })
        .then((page) => {
          if (active) {
            if (!page.comparison)
              setMergeComparisonError("GitHub did not provide the merge comparison.");
            else setMergeComparison(page.comparison);
          }
        })
        .catch((cause: unknown) => {
          if (active)
            setMergeComparisonError(
              cause instanceof Error ? cause.message : "The merge comparison could not be loaded.",
            );
        });
    return () => {
      active = false;
    };
  }, [pendingAction, pr.key, pr.headRefOid, mergeReadAttempt]);
  const [snoozeUntil, setSnoozeUntil] = useState(defaultSnoozeUntil);
  const [isRunning, setIsRunning] = useState(false);
  const [isIgnoring, setIsIgnoring] = useState(false);
  const [candidatePicker, setCandidatePicker] = useState<PrF5CandidatePicker | null>(null);
  const [isOpeningInF5, setIsOpeningInF5] = useState(false);

  const isAuthor = pr.roles.includes("author");
  const isOpen = pr.state === "open";
  const isIgnored = pr.ignoredAt !== null;
  const isSnoozed = isPrSnoozed(pr);
  const runKind = resolvePrF5RunKind(pr, options.advisory);
  const runInF5Label = runKind ? prF5RunLabel(runKind, pr) : null;

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
      if (
        pendingAction === "approve" ||
        pendingAction === "comment" ||
        pendingAction === "requestChanges"
      )
        return;
      if (pendingAction === "merge") {
        if (!mergeComparison) throw new Error("Load the merge comparison before confirming.");
        await api.merge({
          url: pr.url,
          method: mergeMethod,
          expectedComparison: mergeComparison,
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

  const openInF5 = async (candidate: PrHubResolvedCheckout, intent: PrF5Intent) => {
    if (busy.current) return;
    busy.current = true;
    setIsOpeningInF5(true);
    try {
      const api = ensureNativeApi();
      const project = candidate.projectId
        ? await waitForRegisteredProject(candidate.projectId)
        : await registerProjectFromPath(candidate.cwd, candidate.projectTitle);
      const serverConfig = await api.server.getConfig();
      const result = await createPrF5Thread({
        api,
        candidate: { ...candidate, projectId: project.id },
        pr,
        advisory: options.advisory,
        intent,
        preferredModel: project.model,
        providers: serverConfig.providers,
      });
      toastManager.add({
        type: "success",
        title:
          intent === "open" ? "Pull request opened in F5" : `${prF5RunLabel(intent, pr)} started`,
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
      busy.current = false;
      setIsOpeningInF5(false);
    }
  };

  const findCheckout = async (intent: PrF5Intent, selectedPath?: string) => {
    if (busy.current) return;
    busy.current = true;
    setIsOpeningInF5(true);
    let resolved: PrHubResolvedCheckout | undefined;
    try {
      const candidates = await ensureNativeApi().prHub.resolveLocalCheckout({
        key: pr.key,
        ...(selectedPath ? { selectedPath } : { baseDirectory: settings.addProjectBaseDirectory }),
      });
      if (candidates.length === 1) resolved = candidates[0];
      else setCandidatePicker({ candidates, intent });
    } catch (error) {
      setCandidatePicker({
        candidates: [],
        intent,
        error: error instanceof Error ? error.message : "Could not inspect local repositories.",
      });
    } finally {
      busy.current = false;
      setIsOpeningInF5(false);
    }
    if (resolved) await openInF5(resolved, intent);
  };
  const handleOpenInF5 = (intent: PrF5Intent) => findCheckout(intent);
  const selectFolder = async (path?: string) => {
    if (!candidatePicker || busy.current) return;
    const intent = candidatePicker.intent;
    busy.current = true;
    setIsOpeningInF5(true);
    let selected: string | null | undefined;
    try {
      selected = path ?? (await ensureNativeApi().dialogs.pickFolder());
    } catch (error) {
      setCandidatePicker({
        candidates: [],
        intent,
        error: error instanceof Error ? error.message : "Could not select a folder.",
      });
    } finally {
      busy.current = false;
      setIsOpeningInF5(false);
    }
    if (selected?.trim()) await findCheckout(intent, selected.trim());
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

  const accountGeneration = getPrHubAccountGeneration();
  const handleAcknowledge = async () => {
    try {
      if (!accountGeneration) throw new Error("Refresh PR Hub before acknowledging.");
      await ensureNativeApi().prHub.acknowledgeAttention({
        key: pr.key,
        accountGeneration,
        attentionFingerprint: pr.attentionFingerprint,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not acknowledge pull request",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleUnsnooze = () => {
    void ensureNativeApi().prHub.unsnooze({ key: pr.key });
  };

  return {
    flags: { isAuthor, isOpen, isIgnored, isSnoozed, isIgnoring },
    handlers: {
      onAcknowledge: () => void handleAcknowledge(),
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
      reviewers,
      setReviewers,
      mergeMethod,
      mergeComparison,
      mergeComparisonError,
      reloadMergeComparison: () => setMergeReadAttempt((value) => value + 1),
      setMergeMethod,
      snoozeUntil,
      setSnoozeUntil,
      isRunning,
      runAction,
      candidatePicker,
      setCandidatePicker,
      isOpeningInF5,
      openInF5,
      selectFolder,
    },
    runInF5Label,
  };
}
