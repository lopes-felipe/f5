import { useMemo, useState, type Ref } from "react";
import {
  ArchiveIcon,
  ChevronDownIcon,
  CheckIcon,
  GitMergeIcon,
  GithubIcon,
  GitPullRequestIcon,
  MessageSquareIcon,
  PauseIcon,
  RefreshCwIcon,
  SendIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import type {
  PrHubAdvisory,
  PrHubAdvisoryRecommendation,
  PrHubLocalCheckoutCandidate,
  TrackedPullRequest,
} from "@t3tools/contracts";

import { formatRelativeTimeLabel } from "../../lib/relativeTime";
import { cn } from "../../lib/utils";
import { ensureNativeApi } from "../../nativeApi";
import { toastManager } from "../ui/toast";
import { Badge } from "../ui/badge";
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

type PendingAction =
  | "approve"
  | "comment"
  | "requestChanges"
  | "merge"
  | "markReady"
  | "reRequestReview"
  | "snooze"
  | null;

function attentionVariant(pr: TrackedPullRequest): React.ComponentProps<typeof Badge>["variant"] {
  if (pr.attentionState === "ready_to_merge") return "success";
  if (pr.attentionBucket === "needs_you") return "warning";
  if (pr.attentionBucket === "waiting_on_others") return "info";
  if (pr.state !== "open") return "secondary";
  return "outline";
}

function checkLabel(checkRollup: TrackedPullRequest["checkRollup"]): string {
  switch (checkRollup) {
    case "success":
      return "CI passed";
    case "failure":
      return "CI failed";
    case "error":
      return "CI error";
    case "pending":
      return "CI pending";
    case "none":
      return "No CI";
  }
}

function advisoryRecommendationLabel(recommendation: PrHubAdvisoryRecommendation): string {
  switch (recommendation) {
    case "fix_ci":
      return "Fix CI";
    case "wait_for_ci":
      return "Wait for CI";
    case "resolve_conflicts":
      return "Resolve conflicts";
    case "address_review_feedback":
      return "Address feedback";
    case "clarify_feedback":
      return "Clarify feedback";
    case "wait_for_reviewers":
      return "Wait for reviewers";
    case "re_request_review":
      return "Re-request review";
    case "ready_to_merge":
      return "Ready to merge";
    case "review_requested":
      return "Review requested";
    case "no_action":
      return "No action";
  }
}

function advisoryVariant(advisory: PrHubAdvisory): React.ComponentProps<typeof Badge>["variant"] {
  if (advisory.status === "failed") return "error";
  if (advisory.status === "stale") return "warning";
  if (advisory.status === "queued" || advisory.status === "running") return "info";
  switch (advisory.recommendation) {
    case "fix_ci":
    case "resolve_conflicts":
    case "address_review_feedback":
      return "warning";
    case "ready_to_merge":
      return "success";
    case "wait_for_ci":
    case "wait_for_reviewers":
    case "review_requested":
    case "re_request_review":
    case "clarify_feedback":
      return "info";
    case "no_action":
      return "secondary";
  }
}

function advisoryStatusLabel(advisory: PrHubAdvisory): string | null {
  if (advisory.status === "queued") return "Queued";
  if (advisory.status === "running") return "Running";
  if (advisory.status === "stale") return "Stale";
  if (advisory.degraded) return "Degraded";
  if (advisory.truncated) return "Truncated";
  return null;
}

function defaultSnoozeUntil(): string {
  return new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
}

function safeHttpsUrl(input: string): string | null {
  try {
    const url = new URL(input);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

async function openExternalHttps(input: string, label: string): Promise<void> {
  const safeUrl = safeHttpsUrl(input);
  if (!safeUrl) {
    toastManager.add({
      type: "error",
      title: "Could not open link",
      description: `Invalid ${label} URL.`,
    });
    return;
  }
  await ensureNativeApi().shell.openExternal(safeUrl);
}

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
  const [isAdvisoryExpanded, setIsAdvisoryExpanded] = useState(false);
  const [candidatePicker, setCandidatePicker] = useState<PrHubLocalCheckoutCandidate[] | null>(
    null,
  );
  const isAuthor = pr.roles.includes("author");
  const isOpen = pr.state === "open";
  const isIgnored = pr.ignoredAt !== null;
  const canReview =
    isOpen &&
    !isIgnored &&
    !isAuthor &&
    (pr.attentionState === "review_requested" || pr.attentionState === "re_review_requested");
  const canMerge = isOpen && !isIgnored && isAuthor && pr.attentionState === "ready_to_merge";
  const canMarkReady = isOpen && !isIgnored && isAuthor && pr.attentionState === "draft";
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
        "grid min-w-0 grid-cols-[1fr_auto] gap-3 border-b border-border px-4 py-3 last:border-b-0",
        isFocused && "bg-primary/8 ring-1 ring-inset ring-primary/35",
      )}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <GitPullRequestIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {pr.repository.nameWithOwner}#{pr.number}
          </span>
          <span className="min-w-0 truncate text-sm font-medium text-foreground">{pr.title}</span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <Badge variant={attentionVariant(pr)}>{pr.nextAction}</Badge>
          <Badge variant="outline">{checkLabel(pr.checkRollup)}</Badge>
          <span>{pr.author ? `by ${pr.author}` : "unknown author"}</span>
          <span>{formatRelativeTimeLabel(pr.updatedAt)}</span>
          <span>
            +{pr.additions}/-{pr.deletions}
          </span>
          <span>{pr.changedFiles} files</span>
          <span>{pr.unresolvedThreadCount} unresolved</span>
          <span>{pr.commentsCount} comments</span>
          {isSnoozed ? <Badge variant="secondary">Snoozed</Badge> : null}
          {isIgnored ? <Badge variant="secondary">Ignored</Badge> : null}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
        {canReview ? (
          <>
            <Button size="xs" variant="outline" onClick={() => setPendingAction("approve")}>
              <CheckIcon /> Approve
            </Button>
            <Button size="xs" variant="outline" onClick={() => setPendingAction("comment")}>
              <MessageSquareIcon /> Comment
            </Button>
            <Button size="xs" variant="outline" onClick={() => setPendingAction("requestChanges")}>
              <XIcon /> Changes
            </Button>
          </>
        ) : null}
        {canMerge ? (
          <Button size="xs" variant="outline" onClick={() => setPendingAction("merge")}>
            <GitMergeIcon /> Merge
          </Button>
        ) : null}
        {canMarkReady ? (
          <Button size="xs" variant="outline" onClick={() => setPendingAction("markReady")}>
            <SendIcon /> Ready
          </Button>
        ) : null}
        {isOpen &&
        !isIgnored &&
        isAuthor &&
        pr.attentionState === "awaiting_review" &&
        pr.reviewRequestReviewers.length > 0 ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              setReviewers(pr.reviewRequestReviewers.join(", "));
              setPendingAction("reRequestReview");
            }}
          >
            <RefreshCwIcon /> Re-request
          </Button>
        ) : null}
        {isOpen && !isIgnored ? (
          isSnoozed ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                void ensureNativeApi().prHub.unsnooze({ key: pr.key });
              }}
            >
              Unsnooze
            </Button>
          ) : (
            <Button size="xs" variant="outline" onClick={() => setPendingAction("snooze")}>
              <PauseIcon /> Snooze
            </Button>
          )
        ) : null}
        {isOpen && !isIgnored ? (
          <Button size="xs" variant="outline" disabled={isIgnoring} onClick={handleIgnore}>
            <ArchiveIcon /> {isIgnoring ? "Ignoring..." : "Ignore"}
          </Button>
        ) : null}
        {isOpen && !isIgnored && onAnalyzeAdvisory ? (
          <Button
            size="xs"
            variant="outline"
            disabled={isAnalyzingAdvisory}
            onClick={onAnalyzeAdvisory}
          >
            <SparklesIcon className={isAnalyzingAdvisory ? "animate-pulse" : ""} />
            {isAnalyzingAdvisory ? "Suggesting..." : "Suggest"}
          </Button>
        ) : null}
        <Button size="xs" variant="outline" onClick={handleOpenInF5}>
          Open in F5
        </Button>
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            void openExternalHttps(pr.url, "pull request");
          }}
        >
          <GithubIcon /> GitHub
        </Button>
      </div>
      {advisory ? (
        <div className="col-span-2 rounded-md border border-border bg-muted/24 px-3 py-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
            <Badge variant={advisoryVariant(advisory)}>
              {advisoryRecommendationLabel(advisory.recommendation)}
            </Badge>
            {advisoryStatusLabel(advisory) ? (
              <Badge variant="outline">{advisoryStatusLabel(advisory)}</Badge>
            ) : null}
            {advisory.confidence > 0 ? (
              <span className="text-muted-foreground">{advisory.confidence}% confidence</span>
            ) : null}
            <span className="min-w-0 flex-1 text-foreground">{advisory.summary}</span>
            {advisory.findings.length > 0 || advisory.blockers.length > 0 ? (
              <button
                type="button"
                className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                onClick={() => setIsAdvisoryExpanded((value) => !value)}
              >
                Details
                <ChevronDownIcon
                  className={cn("size-3 transition-transform", isAdvisoryExpanded && "rotate-180")}
                />
              </button>
            ) : null}
          </div>
          {isAdvisoryExpanded ? (
            <div className="mt-2 space-y-2 text-xs text-muted-foreground">
              {advisory.blockers.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span>Blockers</span>
                  {advisory.blockers.map((blocker) => (
                    <Badge key={blocker} variant="outline" size="sm">
                      {blocker}
                    </Badge>
                  ))}
                </div>
              ) : null}
              {advisory.findings.length > 0 ? (
                <div className="space-y-1">
                  {advisory.findings.slice(0, 6).map((finding) => {
                    const safeUrl = safeHttpsUrl(finding.url);
                    return (
                      <a
                        key={finding.id}
                        href={safeUrl ?? "#"}
                        className="block rounded-sm px-2 py-1 hover:bg-accent hover:text-foreground"
                        onClick={(event) => {
                          event.preventDefault();
                          void openExternalHttps(finding.url, "finding");
                        }}
                      >
                        <span className="font-medium text-foreground">
                          {finding.validity.replaceAll("_", " ")}
                        </span>
                        {finding.author ? ` by ${finding.author}` : ""}: {finding.summary}
                      </a>
                    );
                  })}
                </div>
              ) : null}
              {advisory.errorMessage ? <div>{advisory.errorMessage}</div> : null}
            </div>
          ) : null}
        </div>
      ) : null}

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
