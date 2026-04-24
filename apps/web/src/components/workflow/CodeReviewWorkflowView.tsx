import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { useThreadDetail } from "../../lib/orchestrationReactQuery";
import { readNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { WorkflowTimelinePhaseList } from "./WorkflowTimelinePhaseList";
import {
  canRetryConsolidation,
  canRetryFailedReviewers,
  statusLabel,
} from "./codeReviewWorkflowView.logic";
import { deriveCodeReviewTimelinePhases } from "./codeReviewWorkflowSidebarTimeline";

export function CodeReviewWorkflowView(props: { workflowId: string }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState<"retry" | "delete" | null>(null);
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
  const showRetryFailed = canRetryFailedReviewers(workflow);
  const showRetryMerge = canRetryConsolidation(workflow);

  const handleRetry = async (scope?: "failed" | "consolidation") => {
    const api = readNativeApi();
    if (!api) {
      return;
    }
    setBusy("retry");
    try {
      await api.orchestration.retryCodeReviewWorkflow({
        workflowId: workflow.id,
        ...(scope ? { scope } : {}),
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
    </div>
  );
}
