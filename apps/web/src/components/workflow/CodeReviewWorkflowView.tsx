import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { useThreadDetail } from "../../lib/orchestrationReactQuery";
import { WORKFLOW_TYPE_DIALOG_LABEL } from "../../lib/workflowType";
import { readNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import ChatMarkdown from "../ChatMarkdown";
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
  collectCodeReviewWorkflowErrors,
  statusLabel,
} from "./codeReviewWorkflowView.logic";
import { deriveCodeReviewTimelinePhases } from "./codeReviewWorkflowSidebarTimeline";
import { WorkflowPageLayout, WorkflowPageNotFound } from "./WorkflowPageLayout";
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

export function CodeReviewWorkflowView(props: { workflowId: string }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState<"retry" | "delete" | null>(null);
  const [duplicateRisk, setDuplicateRisk] = useState<DuplicateRisk | null>(null);
  const workflow = useStore((store) =>
    store.codeReviewWorkflows.find((entry) => entry.id === props.workflowId),
  );
  const threads = useStore((store) => store.threads);
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
    return <WorkflowPageNotFound />;
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
        {consolidatedText ? (
          <WorkflowArtifactSection title="Merged Review">
            <ChatMarkdown text={consolidatedText} cwd={undefined} />
          </WorkflowArtifactSection>
        ) : null}
        <WorkflowInputSection
          label="Review Instructions"
          text={workflow.reviewPrompt}
          defaultOpen={!consolidatedText}
        >
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
    </>
  );
}
