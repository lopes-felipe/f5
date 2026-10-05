import {
  planningWorkflowDocumentType,
  WORKFLOW_DOCUMENT_PROFILES,
  documentReaderPersona,
  documentReaderPassPhase,
  validateDocumentArtifact,
} from "@t3tools/shared/documentWorkflow";
import { MarkdownArtifactActions } from "../chat/MarkdownArtifactActions";
import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { useTheme } from "../../hooks/useTheme";
import { WORKFLOW_TYPE_DIALOG_LABEL } from "../../lib/workflowType";
import { readNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import ChatMarkdown from "../ChatMarkdown";
import { FileChip } from "../chat/FileChip";
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
import { toastManager } from "../ui/toast";
import { WorkflowImplementDialog } from "./WorkflowImplementDialog";
import { WorkflowPageLayout, WorkflowPageNotFound } from "./WorkflowPageLayout";
import {
  WorkflowArtifactSection,
  WorkflowFailedSteps,
  WorkflowInputSection,
} from "./WorkflowSections";
import {
  canStartImplementation,
  resolveDocumentDisplayMarkdown,
  resolveApprovedMergedPlanMarkdown,
} from "./workflowUtils";
import { deriveTimelinePhases } from "./workflowSidebarTimeline";
import { overallStateFromPhases } from "./workflowTimelineTypes";
import { WorkflowRunInspector } from "./WorkflowRunInspector";
import {
  canRetryFailedPlanningWorkflow,
  collectPlanningWorkflowErrors,
  planningWorkflowStatusLabel,
} from "./planningWorkflowView.logic";

function retryErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to retry workflow.";
}

export function WorkflowView(props: { workflowId: string }) {
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  const [implementDialogOpen, setImplementDialogOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [skipOpen, setSkipOpen] = useState(false);
  const [duplicateRiskThreadIds, setDuplicateRiskThreadIds] = useState<readonly string[]>([]);
  const workflow = useStore((store) =>
    store.planningWorkflows.find((entry) => entry.id === props.workflowId),
  );
  const threads = useStore((store) => store.threads);
  const cwd = useStore(
    (store) => store.projects.find((project) => project.id === workflow?.projectId)?.cwd,
  );
  const threadById = useMemo(
    () => new Map(threads.map((thread) => [thread.id, thread] as const)),
    [threads],
  );
  const timelinePhases = useMemo(
    () => (workflow ? deriveTimelinePhases(workflow) : []),
    [workflow],
  );
  const workflowErrors = useMemo(
    () => (workflow ? collectPlanningWorkflowErrors(workflow) : []),
    [workflow],
  );

  if (!workflow) {
    return <WorkflowPageNotFound />;
  }

  const mergeThread = workflow.merge.threadId ? threadById.get(workflow.merge.threadId) : null;
  const documentType = planningWorkflowDocumentType(workflow);
  const documentProfile = documentType ? WORKFLOW_DOCUMENT_PROFILES[documentType] : null;
  const readerPhase = documentReaderPassPhase(workflow);
  const mergedPlan = documentType
    ? resolveDocumentDisplayMarkdown(workflow, mergeThread)
    : resolveApprovedMergedPlanMarkdown(workflow, mergeThread);
  const latestPlan = mergeThread?.proposedPlans.at(-1);
  const incompleteReply =
    documentType &&
    workflow.merge.status === "manual_review" &&
    latestPlan &&
    latestPlan.id !== workflow.merge.approvedPlanId &&
    !validateDocumentArtifact(latestPlan.planMarkdown, documentType, "replacement").valid;

  const implementationStartable = canStartImplementation(workflow);
  const retryable = canRetryFailedPlanningWorkflow(workflow);

  const handleRetry = async (allowPossibleDuplicate = false) => {
    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Workflow retry is unavailable while disconnected.",
      });
      return;
    }
    setRetrying(true);
    try {
      const result = await api.orchestration.retryWorkflow({
        workflowId: workflow.id,
        allowPossibleDuplicate,
      });
      setDuplicateRiskThreadIds(result.status === "confirmation_required" ? result.threadIds : []);
    } catch (error) {
      if (allowPossibleDuplicate) {
        setDuplicateRiskThreadIds([]);
      }
      toastManager.add({ type: "error", title: retryErrorMessage(error) });
    } finally {
      setRetrying(false);
    }
  };

  const actions = (
    <>
      {retryable ? (
        <Button variant="outline" onClick={() => void handleRetry()} disabled={retrying}>
          Retry failed
        </Button>
      ) : null}
      {documentType && workflow.readerPass?.status === "error" ? (
        <Button variant="outline" onClick={() => setSkipOpen(true)}>
          Finish without reader review
        </Button>
      ) : null}
      {documentType && workflow.merge.status === "manual_review" && workflow.merge.threadId ? (
        <Button
          variant="outline"
          onClick={() =>
            void navigate({
              to: "/$threadId",
              params: { threadId: workflow.merge.threadId! },
            })
          }
        >
          Refine in chat
        </Button>
      ) : null}
      {implementationStartable ? (
        <Button onClick={() => setImplementDialogOpen(true)}>Implement</Button>
      ) : null}
    </>
  );

  return (
    <>
      <WorkflowPageLayout
        projectId={workflow.projectId}
        workflowType={documentType ? "document" : "planning"}
        typeLabel={
          documentProfile
            ? `Document · ${documentProfile.label}`
            : WORKFLOW_TYPE_DIALOG_LABEL.planning
        }
        title={workflow.title}
        statusLabel={planningWorkflowStatusLabel(workflow)}
        overallState={overallStateFromPhases(timelinePhases)}
        totalCostUsd={workflow.totalCostUsd}
        createdAt={workflow.createdAt}
        updatedAt={workflow.updatedAt}
        actions={actions}
        phases={timelinePhases}
        threadById={threadById}
      >
        <WorkflowFailedSteps errors={workflowErrors} />
        {mergedPlan ? (
          <WorkflowArtifactSection
            title={
              documentType
                ? workflow.merge.status === "merged"
                  ? "Merged draft"
                  : "Final document"
                : "Merged plan"
            }
            actions={
              <>
                {workflow.merge.outputFilePath ? (
                  <FileChip
                    path={workflow.merge.outputFilePath}
                    theme={resolvedTheme}
                    size="sm"
                    className="max-w-72"
                  />
                ) : null}
                {documentType ? (
                  <MarkdownArtifactActions
                    markdown={mergedPlan}
                    workspaceRoot={cwd}
                    artifactNoun="document"
                  />
                ) : null}
              </>
            }
            note={
              documentType && workflow.merge.status === "merged" ? (
                <p className="mb-3 text-ui text-muted-foreground">
                  {readerPhase === "polishing"
                    ? "Polishing"
                    : readerPhase === "error"
                      ? "Reader pass failed"
                      : "Reader review in progress"}
                </p>
              ) : null
            }
          >
            <ChatMarkdown text={mergedPlan} cwd={documentType ? cwd : undefined} />
            {incompleteReply ? (
              <p className="mt-3 text-ui text-muted-foreground">
                The latest merge-chat reply was not a complete {documentProfile?.label}, so the
                final document was not updated.
              </p>
            ) : null}
          </WorkflowArtifactSection>
        ) : (
          <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            {documentType
              ? "The document will appear here after the drafts are reviewed and merged."
              : "The merged plan will appear here once the workflow reaches manual review."}
          </p>
        )}
        <WorkflowInputSection
          label={documentType ? "Brief" : "Requirement"}
          text={workflow.requirementPrompt}
          defaultOpen={!mergedPlan}
        >
          {documentType && workflow.readerReviewEnabled ? (
            <p className="mt-3 flex flex-wrap items-center gap-x-2 text-ui text-muted-foreground">
              Reader: {documentReaderPersona(workflow)} · {workflow.readerSlot?.model}
            </p>
          ) : null}
        </WorkflowInputSection>
        {documentType && workflow.readerReviewEnabled && workflow.readerPass?.pinnedTurnId ? (
          <div>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void navigate({
                  to: "/$threadId",
                  params: { threadId: workflow.readerPass!.readerThreadId },
                })
              }
            >
              View reader report
            </Button>
          </div>
        ) : null}
        <WorkflowRunInspector
          runKind="planning"
          workflowId={workflow.id}
          updatedAt={workflow.updatedAt}
        />
      </WorkflowPageLayout>
      <WorkflowImplementDialog
        open={implementDialogOpen && implementationStartable}
        workflow={workflow}
        onOpenChange={setImplementDialogOpen}
      />
      <AlertDialog open={skipOpen} onOpenChange={setSkipOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Finish without reader review?</AlertDialogTitle>
            <AlertDialogDescription>
              The merged document becomes final without the reader's changes. You can still refine
              it in chat.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              disabled={retrying}
              onClick={() => {
                const api = readNativeApi();
                if (!api) return;
                setRetrying(true);
                void api.orchestration
                  .skipDocumentReaderPass({ workflowId: workflow.id })
                  .then(() => setSkipOpen(false))
                  .catch((error) =>
                    toastManager.add({
                      type: "error",
                      title:
                        error instanceof Error
                          ? error.message
                          : "Failed to finish without reader review.",
                    }),
                  )
                  .finally(() => setRetrying(false));
              }}
            >
              Finish without reader review
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <AlertDialog
        open={duplicateRiskThreadIds.length > 0}
        onOpenChange={(open) => {
          if (!open && !retrying) setDuplicateRiskThreadIds([]);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Retry may duplicate a provider turn</AlertDialogTitle>
            <AlertDialogDescription>
              Delivery could not be confirmed for {duplicateRiskThreadIds.length} failed thread
              {duplicateRiskThreadIds.length === 1 ? "" : "s"}. Continue only if duplicate work is
              acceptable.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={retrying} />}>
              Cancel
            </AlertDialogClose>
            <Button onClick={() => void handleRetry(true)} disabled={retrying}>
              Retry anyway
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
