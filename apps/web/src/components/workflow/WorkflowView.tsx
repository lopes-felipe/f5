import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";

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
import { toastManager } from "../ui/toast";
import { WorkflowTimelinePhaseList } from "./WorkflowTimelinePhaseList";
import { WorkflowImplementDialog } from "./WorkflowImplementDialog";
import { canStartImplementation, resolveApprovedMergedPlanMarkdown } from "./workflowUtils";
import { deriveTimelinePhases } from "./workflowSidebarTimeline";
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
  const [implementDialogOpen, setImplementDialogOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [duplicateRiskThreadIds, setDuplicateRiskThreadIds] = useState<readonly string[]>([]);
  const workflow = useStore((store) =>
    store.planningWorkflows.find((entry) => entry.id === props.workflowId),
  );
  const threads = useStore((store) => store.threads);

  if (!workflow) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Workflow not found.
      </div>
    );
  }

  const mergeThread = workflow.merge.threadId
    ? threads.find((thread) => thread.id === workflow.merge.threadId)
    : null;
  const mergedPlan = resolveApprovedMergedPlanMarkdown(workflow, mergeThread);
  const implementationStartable = canStartImplementation(workflow);
  const threadById = new Map(threads.map((thread) => [thread.id, thread] as const));
  const timelinePhases = deriveTimelinePhases(workflow);
  const workflowErrors = collectPlanningWorkflowErrors(workflow);
  const retryable = canRetryFailedPlanningWorkflow(workflow);
  const formattedCost =
    workflow.totalCostUsd <= 0
      ? null
      : workflow.totalCostUsd < 0.01
        ? "<$0.01"
        : `$${workflow.totalCostUsd.toFixed(2)}`;

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

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="border-b border-border px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Workflow</p>
            <h1 className="mt-1 text-2xl font-semibold text-foreground">{workflow.title}</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {planningWorkflowStatusLabel(workflow)}
              {formattedCost ? ` · ${formattedCost}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {retryable ? (
              <Button variant="outline" onClick={() => void handleRetry()} disabled={retrying}>
                Retry failed
              </Button>
            ) : null}
            {implementationStartable ? (
              <Button onClick={() => setImplementDialogOpen(true)}>Implement</Button>
            ) : null}
            <Button variant="outline" onClick={() => void navigate({ to: "/" })}>
              Back to chat
            </Button>
          </div>
        </div>
      </div>
      <div className="grid min-h-0 flex-1 gap-6 p-6 lg:grid-cols-[22rem_minmax(0,1fr)]">
        <aside className="overflow-auto rounded-xl border border-border bg-card p-4">
          <WorkflowTimelinePhaseList phases={timelinePhases} threadById={threadById} />
        </aside>
        <main className="min-h-0 min-w-0 rounded-xl border border-border bg-card">
          <div className="flex h-full min-h-0 min-w-0 flex-col p-5">
            <div className="min-h-0 min-w-0 flex-1 space-y-6 overflow-y-auto overscroll-y-contain">
              <WorkflowRunInspector
                runKind="planning"
                workflowId={workflow.id}
                updatedAt={workflow.updatedAt}
              />
              {workflowErrors.length > 0 ? (
                <section className="rounded-lg border border-destructive/40 bg-destructive/5 p-4">
                  <h2 className="text-sm font-semibold text-destructive">Failed steps</h2>
                  <div className="mt-3 space-y-3">
                    {workflowErrors.map((error) => (
                      <div key={error.key}>
                        <p className="text-xs font-medium text-foreground">{error.step}</p>
                        <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                          {error.message}
                        </p>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}
              <section>
                <h2 className="text-sm font-semibold text-foreground">Requirement</h2>
                <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
                  {workflow.requirementPrompt}
                </p>
              </section>
              {mergedPlan ? (
                <section>
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <h2 className="text-sm font-semibold text-foreground">Merged plan</h2>
                    {workflow.merge.outputFilePath ? (
                      <span className="text-xs text-muted-foreground">
                        {workflow.merge.outputFilePath}
                      </span>
                    ) : null}
                  </div>
                  <ChatMarkdown text={mergedPlan} cwd={undefined} />
                </section>
              ) : (
                <section className="text-sm text-muted-foreground">
                  The merged plan will appear here once the workflow reaches manual review.
                </section>
              )}
            </div>
          </div>
        </main>
      </div>
      <WorkflowImplementDialog
        open={implementDialogOpen && implementationStartable}
        workflow={workflow}
        onOpenChange={setImplementDialogOpen}
      />
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
    </div>
  );
}
