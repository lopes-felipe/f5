import { useWorkflowDetails, WorkflowDetailsStatus } from "../../hooks/useWorkflowDetails";
import type { ThreadId } from "@t3tools/contracts";
import {
  codeReviewPullRequestLabel,
  formatCodeReviewReport,
} from "@t3tools/shared/codeReviewPullRequest";
import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { useThreadDetail } from "../../lib/orchestrationReactQuery";
import { WORKFLOW_TYPE_DIALOG_LABEL } from "../../lib/workflowType";
import { readNativeApi } from "../../nativeApi";
import { useThreadsByIds } from "../../threadSelectors";
import { threadIdsForCodeReviewWorkflow } from "./codeReviewWorkflowUtils";
import ChatMarkdown from "../ChatMarkdown";
import { OpenLinkAnchor } from "../OpenLinkAnchor";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import {
  canRetryConsolidation,
  canRetryFailedReviewers,
  codeReviewPostAction,
  collectCodeReviewWorkflowErrors,
  statusLabel,
} from "./codeReviewWorkflowView.logic";
import { deriveCodeReviewTimelinePhases } from "./codeReviewWorkflowSidebarTimeline";
import { WorkflowPageLayout } from "./WorkflowPageLayout";
import { WorkflowRunInspector } from "./WorkflowRunInspector";
import {
  WorkflowArtifactSection,
  WorkflowFailedSteps,
  WorkflowInputSection,
} from "./WorkflowSections";
import { overallStateFromPhases } from "./workflowTimelineTypes";

function retryErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to retry code review.";
}

type RetryScope = "failed" | "consolidation";

interface DuplicateRisk {
  readonly scope: RetryScope;
  readonly threadIds: readonly string[];
}

const EMPTY_WORKFLOW_THREAD_IDS: readonly ThreadId[] = [];

export function CodeReviewWorkflowView(props: { workflowId: string }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState<"retry" | "delete" | "post" | null>(null);
  const [duplicateRisk, setDuplicateRisk] = useState<DuplicateRisk | null>(null);
  const [confirmPostAgain, setConfirmPostAgain] = useState(false);
  const detail = useWorkflowDetails("codeReview", props.workflowId);
  const workflow = detail.workflow;
  // Only this workflow's threads: unrelated streaming does not re-render the view.
  const workflowThreadIds = useMemo(
    () => (workflow ? threadIdsForCodeReviewWorkflow(workflow) : EMPTY_WORKFLOW_THREAD_IDS),
    [workflow],
  );
  const threads = useThreadsByIds(workflowThreadIds);
  const consolidationThreadId = workflow?.consolidation.threadId ?? null;
  useThreadDetail(consolidationThreadId);
  const threadById = useMemo(
    () => new Map(threads.map((thread) => [thread.id, thread] as const)),
    [threads],
  );
  const timelinePhases = useMemo(
    () => (workflow ? deriveCodeReviewTimelinePhases(workflow) : []),
    [workflow],
  );
  const workflowErrors = useMemo(
    () => (workflow ? collectCodeReviewWorkflowErrors(workflow) : []),
    [workflow],
  );

  if (!workflow) {
    return (
      <WorkflowDetailsStatus missing={detail.missing} error={detail.error} retry={detail.retry} />
    );
  }

  const consolidationThread = consolidationThreadId ? threadById.get(consolidationThreadId) : null;
  const consolidatedText =
    workflow.consolidation.pinnedAssistantMessageId && consolidationThread?.detailsLoaded
      ? (consolidationThread.messages.find(
          (message) => message.id === workflow.consolidation.pinnedAssistantMessageId,
        )?.text ?? null)
      : ((consolidationThread?.detailsLoaded
          ? consolidationThread.messages
              .toReversed()
              .find((message) => message.role === "assistant" && !message.streaming)?.text
          : null) ?? null);
  const pullRequest = workflow.pullRequest ?? null;
  const mergedReviewText = consolidatedText
    ? formatCodeReviewReport(consolidatedText, { pullRequest })
    : null;
  const postAction = codeReviewPostAction(workflow);
  const showRetryFailed = canRetryFailedReviewers(workflow);
  const showRetryMerge = canRetryConsolidation(workflow);

  const handleRetry = async (scope: RetryScope, allowPossibleDuplicate = false) => {
    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Code-review retry is unavailable while disconnected.",
      });
      return;
    }
    setBusy("retry");
    try {
      const result = await api.orchestration.retryCodeReviewWorkflow({
        workflowId: workflow.id,
        scope,
        allowPossibleDuplicate,
      });
      setDuplicateRisk(
        result.status === "confirmation_required" ? { scope, threadIds: result.threadIds } : null,
      );
    } catch (error) {
      if (allowPossibleDuplicate) {
        setDuplicateRisk(null);
      }
      toastManager.add({ type: "error", title: retryErrorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  const handlePost = async () => {
    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Posting is unavailable while disconnected.",
      });
      return;
    }
    setBusy("post");
    try {
      await api.orchestration.postCodeReviewWorkflow({ workflowId: workflow.id });
      setConfirmPostAgain(false);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: error instanceof Error ? error.message : "Failed to post the merged review.",
      });
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async () => {
    const api = readNativeApi();
    if (!api) {
      return;
    }
    setBusy("delete");
    try {
      await api.orchestration.deleteCodeReviewWorkflow({ workflowId: workflow.id });
      await navigate({ to: "/" });
    } finally {
      setBusy(null);
    }
  };

  const actions = (
    <>
      {postAction?.kind === "posted" && postAction.commentUrl ? (
        <Button
          variant="outline"
          render={<OpenLinkAnchor href={postAction.commentUrl} target="_blank" rel="noreferrer" />}
        >
          Posted
        </Button>
      ) : postAction ? (
        <Button
          variant="outline"
          onClick={() =>
            postAction.kind === "post-again" ? setConfirmPostAgain(true) : void handlePost()
          }
          disabled={busy !== null || postAction.kind === "posting" || postAction.kind === "posted"}
        >
          {postAction.label}
        </Button>
      ) : null}
      {showRetryFailed ? (
        <Button
          variant="outline"
          onClick={() => void handleRetry("failed")}
          disabled={busy !== null}
        >
          Retry failed
        </Button>
      ) : null}
      {showRetryMerge ? (
        <Button
          variant="outline"
          onClick={() => void handleRetry("consolidation")}
          disabled={busy !== null}
        >
          Retry merge
        </Button>
      ) : null}
      <Button variant="outline" onClick={() => void handleDelete()} disabled={busy !== null}>
        Delete
      </Button>
    </>
  );

  return (
    <>
      <WorkflowPageLayout
        projectId={workflow.projectId}
        workflowType="codeReview"
        typeLabel={WORKFLOW_TYPE_DIALOG_LABEL.codeReview}
        title={workflow.title}
        statusLabel={statusLabel(workflow)}
        overallState={overallStateFromPhases(timelinePhases)}
        totalCostUsd={workflow.totalCostUsd}
        createdAt={workflow.createdAt}
        updatedAt={workflow.updatedAt}
        actions={actions}
        phases={timelinePhases}
        threadById={threadById}
      >
        <WorkflowFailedSteps errors={workflowErrors} />
        {consolidationThread && !consolidationThread.detailsLoaded ? (
          <WorkflowArtifactSection title="Merged Review">
            <div className="space-y-3">
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-[92%]" />
              <Skeleton className="h-4 w-[76%]" />
            </div>
          </WorkflowArtifactSection>
        ) : null}
        {mergedReviewText ? (
          <WorkflowArtifactSection title="Merged Review">
            <ChatMarkdown text={mergedReviewText} cwd={undefined} />
          </WorkflowArtifactSection>
        ) : null}
        <WorkflowInputSection
          label="Review Instructions"
          text={workflow.reviewPrompt}
          defaultOpen={!consolidatedText}
        >
          {pullRequest ? (
            <p className="mt-2 text-ui text-muted-foreground">
              Pull request:{" "}
              <OpenLinkAnchor
                href={pullRequest.url}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-foreground underline"
              >
                {codeReviewPullRequestLabel(pullRequest)}
              </OpenLinkAnchor>
            </p>
          ) : null}
          {workflow.branch ? (
            <p className="mt-2 text-ui text-muted-foreground">
              Branch: <span className="font-mono">{workflow.branch}</span>
            </p>
          ) : null}
        </WorkflowInputSection>
        <WorkflowRunInspector
          runKind="codeReview"
          workflowId={workflow.id}
          updatedAt={workflow.updatedAt}
        />
      </WorkflowPageLayout>
      <AlertDialog
        open={duplicateRisk !== null}
        onOpenChange={(open) => {
          if (!open && busy !== "retry") setDuplicateRisk(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Retry may duplicate a provider turn</AlertDialogTitle>
            <AlertDialogDescription>
              Delivery could not be confirmed for {duplicateRisk?.threadIds.length ?? 0} failed
              thread{duplicateRisk?.threadIds.length === 1 ? "" : "s"}. Continue only if duplicate
              work is acceptable.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={busy === "retry"} />}>
              Cancel
            </AlertDialogClose>
            <Button
              onClick={() => {
                if (duplicateRisk) {
                  void handleRetry(duplicateRisk.scope, true);
                }
              }}
              disabled={busy === "retry"}
            >
              Retry anyway
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <AlertDialog
        open={confirmPostAgain}
        onOpenChange={(open) => {
          if (!open && busy !== "post") setConfirmPostAgain(false);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Post the new merged review?</AlertDialogTitle>
            <AlertDialogDescription>
              An earlier merged review is already posted to this pull request. Posting adds a second
              comment; the earlier one stays.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={busy === "post"} />}>
              Cancel
            </AlertDialogClose>
            <Button onClick={() => void handlePost()} disabled={busy === "post"}>
              Post again
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
