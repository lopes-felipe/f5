import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { useThreadDetail } from "../../lib/orchestrationReactQuery";
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
import { WorkflowTimelinePhaseList } from "./WorkflowTimelinePhaseList";
import {
  canRetryConsolidation,
  canRetryFailedReviewers,
  collectCodeReviewWorkflowErrors,
  statusLabel,
} from "./codeReviewWorkflowView.logic";
import { deriveCodeReviewTimelinePhases } from "./codeReviewWorkflowSidebarTimeline";
import { WorkflowRunInspector } from "./WorkflowRunInspector";

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

  if (!workflow) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Workflow not found.
      </div>
    );
  }

  const consolidationThread = consolidationThreadId
    ? threads.find((thread) => thread.id === consolidationThreadId)
    : null;
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
  const threadById = new Map(threads.map((thread) => [thread.id, thread] as const));
  const timelinePhases = deriveCodeReviewTimelinePhases(workflow);
  const workflowErrors = collectCodeReviewWorkflowErrors(workflow);
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

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="border-b border-border px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Code Review</p>
            <h1 className="mt-1 text-2xl font-semibold text-foreground">{workflow.title}</h1>
            <p className="mt-2 text-sm text-muted-foreground">{statusLabel(workflow)}</p>
          </div>
          <div className="flex items-center gap-2">
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
                runKind="codeReview"
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
                <h2 className="text-sm font-semibold text-foreground">Review Instructions</h2>
                <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
                  {workflow.reviewPrompt}
                </p>
                {workflow.branch ? (
                  <p className="mt-2 text-xs text-muted-foreground">Branch: {workflow.branch}</p>
                ) : null}
              </section>
              {consolidationThread && !consolidationThread.detailsLoaded ? (
                <section>
                  <h2 className="mb-3 text-sm font-semibold text-foreground">Merged Review</h2>
                  <div className="space-y-3 rounded-lg border border-border bg-background p-4">
                    <Skeleton className="h-4 w-36" />
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-[92%]" />
                    <Skeleton className="h-4 w-[76%]" />
                  </div>
                </section>
              ) : null}
              {consolidatedText ? (
                <section>
                  <h2 className="mb-3 text-sm font-semibold text-foreground">Merged Review</h2>
                  <div className="rounded-lg border border-border bg-background p-4">
                    <ChatMarkdown text={consolidatedText} cwd={undefined} />
                  </div>
                </section>
              ) : null}
            </div>
          </div>
        </main>
      </div>
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
    </div>
  );
}
