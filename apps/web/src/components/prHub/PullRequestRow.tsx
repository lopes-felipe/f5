import { useMemo, useState, type Ref } from "react";
import { GitPullRequestIcon } from "lucide-react";
import type {
  PrHubAdvisory,
  PrHubLocalCheckoutCandidate,
  TrackedPullRequest,
} from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { ensureNativeApi } from "../../nativeApi";
import { toastManager } from "../ui/toast";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectButton, SelectItem, SelectPopup } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { attentionAccentClass, defaultSnoozeUntil, openExternalHttps } from "./prHubPresentation";
import { PrAdvisoryInline } from "./PrAdvisoryInline";
import { PrMetaStrip } from "./PrMetaStrip";
import { PrRowActions } from "./PrRowActions";

type PendingAction =
  | "approve"
  | "comment"
  | "requestChanges"
  | "merge"
  | "markReady"
  | "reRequestReview"
  | "snooze"
  | null;

export function PullRequestRow({
  pr,
  advisory,
  isAnalyzingAdvisory = false,
  onAnalyzeAdvisory,
  isFocused = false,
  rowRef,
}: {
  pr: TrackedPullRequest;
  advisory?: PrHubAdvisory | undefined;
  isAnalyzingAdvisory?: boolean;
  onAnalyzeAdvisory?: (() => void) | undefined;
  isFocused?: boolean;
  rowRef?: Ref<HTMLDivElement>;
}) {
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [body, setBody] = useState("");
  const [reviewers, setReviewers] = useState("");
  const [mergeMethod, setMergeMethod] = useState<"squash" | "merge" | "rebase">("squash");
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

  return (
    <div
      ref={rowRef}
      className={cn(
        "relative flex min-w-0 gap-3 border-b border-border py-2.5 pe-4 ps-5 last:border-b-0 hover:bg-accent/24",
        isFocused && "bg-primary/8 ring-1 ring-inset ring-primary/35",
      )}
    >
      <span
        aria-hidden="true"
        className={cn("absolute inset-y-2 start-1.5 w-0.5 rounded-full", attentionAccentClass(pr))}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 items-start gap-2">
          <GitPullRequestIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {pr.repository.nameWithOwner}#{pr.number}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              {pr.title}
            </span>
          </div>
          <PrRowActions
            pr={pr}
            isAuthor={isAuthor}
            isOpen={isOpen}
            isIgnored={isIgnored}
            isSnoozed={isSnoozed}
            isIgnoring={isIgnoring}
            isAnalyzingAdvisory={isAnalyzingAdvisory}
            onApprove={() => setPendingAction("approve")}
            onComment={() => setPendingAction("comment")}
            onRequestChanges={() => setPendingAction("requestChanges")}
            onMerge={() => setPendingAction("merge")}
            onMarkReady={() => setPendingAction("markReady")}
            onReRequest={() => {
              setReviewers(pr.reviewRequestReviewers.join(", "));
              setPendingAction("reRequestReview");
            }}
            onSnooze={() => setPendingAction("snooze")}
            onUnsnooze={() => {
              void ensureNativeApi().prHub.unsnooze({ key: pr.key });
            }}
            onIgnore={handleIgnore}
            {...(onAnalyzeAdvisory ? { onAnalyzeAdvisory } : {})}
            onOpenInF5={() => void handleOpenInF5()}
            onOpenGitHub={() => void openExternalHttps(pr.url, "pull request")}
          />
        </div>

        <PrMetaStrip pr={pr} isSnoozed={isSnoozed} isIgnored={isIgnored} />

        {advisory ? <PrAdvisoryInline advisory={advisory} /> : null}
      </div>

      <Dialog
        open={pendingAction !== null}
        onOpenChange={(open) => !open && setPendingAction(null)}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{dialogTitle}</DialogTitle>
            <DialogDescription>
              {pr.repository.nameWithOwner}#{pr.number} · {pr.title}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            {pendingAction === "approve" ||
            pendingAction === "comment" ||
            pendingAction === "requestChanges" ? (
              <Textarea
                value={body}
                onChange={(event) => setBody(event.currentTarget.value)}
                placeholder={pendingAction === "approve" ? "Optional review note" : "Comment"}
              />
            ) : null}
            {pendingAction === "merge" ? (
              <Select
                value={mergeMethod}
                onValueChange={(value) => setMergeMethod(value as typeof mergeMethod)}
              >
                <SelectButton size="sm">{mergeMethod}</SelectButton>
                <SelectPopup>
                  <SelectItem value="squash">squash</SelectItem>
                  <SelectItem value="merge">merge</SelectItem>
                  <SelectItem value="rebase">rebase</SelectItem>
                </SelectPopup>
              </Select>
            ) : null}
            {pendingAction === "reRequestReview" ? (
              <Textarea
                value={reviewers}
                onChange={(event) => setReviewers(event.currentTarget.value)}
                placeholder="reviewer1, reviewer2"
              />
            ) : null}
            {pendingAction === "snooze" ? (
              <input
                className="h-8 w-full rounded-lg border border-input bg-background px-3 text-sm"
                type="datetime-local"
                value={snoozeUntil.slice(0, 16)}
                onChange={(event) =>
                  setSnoozeUntil(new Date(event.currentTarget.value).toISOString())
                }
              />
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button
              onClick={runAction}
              disabled={
                isRunning || (pendingAction === "reRequestReview" && reviewers.trim().length === 0)
              }
            >
              {isRunning ? "Working..." : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={candidatePicker !== null}
        onOpenChange={(open) => !open && setCandidatePicker(null)}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Choose local clone</DialogTitle>
            <DialogDescription>{pr.repository.nameWithOwner}</DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-2">
            {(candidatePicker ?? []).map((candidate) => (
              <button
                key={`${candidate.projectId}:${candidate.cwd}`}
                type="button"
                className="flex w-full min-w-0 flex-col rounded-lg border border-border px-3 py-2 text-left hover:bg-accent"
                onClick={() => void openInF5(candidate)}
              >
                <span className="truncate text-sm font-medium">{candidate.projectTitle}</span>
                <span className="truncate text-xs text-muted-foreground">{candidate.cwd}</span>
              </button>
            ))}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
