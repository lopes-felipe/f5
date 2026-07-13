import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { useThreadDetail } from "../../lib/orchestrationReactQuery";
import { readNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import type { ChatMessage } from "../../types";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { WorkflowTimelinePhaseList } from "./WorkflowTimelinePhaseList";
import {
  canRetryCrossReview,
  canRetryFailedInvestigationPhase,
  canRetrySelfReview,
  canRetrySynthesis,
  statusLabel,
} from "./investigationWorkflowView.logic";
import { deriveInvestigationTimelinePhases } from "./investigationWorkflowSidebarTimeline";
import { WorkflowRunInspector } from "./WorkflowRunInspector";

function combinedAssistantFeedback(
  messages: ReadonlyArray<ChatMessage>,
  pinnedAssistantMessageId: string | null,
): string | null {
  const message = pinnedAssistantMessageId
    ? messages.find((entry) => entry.id === pinnedAssistantMessageId)
    : messages.toReversed().find((entry) => entry.role === "assistant" && !entry.streaming);
  if (!message || message.role !== "assistant" || message.streaming) {
    return null;
  }
  const text = message.text.trim();
  const reasoning = (message.reasoningText ?? "").trim();
  if (text.length === 0 && reasoning.length === 0) {
    return null;
  }
  if (text.length === 0) {
    return reasoning;
  }
  if (reasoning.length === 0) {
    return text;
  }
  return `${text}\n\n## RCA reasoning\n\n${reasoning}`;
}

export function InvestigationWorkflowView(props: { workflowId: string }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState<"retry" | "delete" | null>(null);
  const workflow = useStore((store) =>
    store.investigationWorkflows.find((entry) => entry.id === props.workflowId),
  );
  const threads = useStore((store) => store.threads);
  const project = useStore((store) =>
    workflow ? (store.projects.find((entry) => entry.id === workflow.projectId) ?? null) : null,
  );
  const synthesisThreadId = workflow?.synthesis.threadId ?? null;
  useThreadDetail(synthesisThreadId);

  if (!workflow) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Workflow not found.
      </div>
    );
  }

  const synthesisThread = synthesisThreadId
    ? threads.find((thread) => thread.id === synthesisThreadId)
    : null;
  const rcaText =
    synthesisThread?.detailsLoaded === true
      ? combinedAssistantFeedback(
          synthesisThread.messages,
          workflow.synthesis.pinnedAssistantMessageId,
        )
      : null;
  const threadById = new Map(threads.map((thread) => [thread.id, thread] as const));
  const timelinePhases = deriveInvestigationTimelinePhases(workflow);
  const showRetryFailed = canRetryFailedInvestigationPhase(workflow);
  const showRetryCrossReview = canRetryCrossReview(workflow);
  const showRetrySelfReview = canRetrySelfReview(workflow);
  const showRetrySynthesis = canRetrySynthesis(workflow);

  const handleRetry = async (scope?: "failed" | "crossReview" | "selfReview" | "synthesis") => {
    const api = readNativeApi();
    if (!api) {
      return;
    }
    setBusy("retry");
    try {
      await api.orchestration.retryInvestigationWorkflow({
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
      await api.orchestration.deleteInvestigationWorkflow({ workflowId: workflow.id });
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
            <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
              Investigation
            </p>
            <h1 className="mt-1 text-2xl font-semibold text-foreground">{workflow.title}</h1>
            <p className="mt-2 text-sm text-muted-foreground">{statusLabel(workflow)}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {showRetryFailed ? (
              <Button
                variant="outline"
                onClick={() => void handleRetry("failed")}
                disabled={busy !== null}
              >
                Retry failed
              </Button>
            ) : null}
            {showRetryCrossReview ? (
              <Button
                variant="outline"
                onClick={() => void handleRetry("crossReview")}
                disabled={busy !== null}
              >
                Retry cross-review
              </Button>
            ) : null}
            {showRetrySelfReview ? (
              <Button
                variant="outline"
                onClick={() => void handleRetry("selfReview")}
                disabled={busy !== null}
              >
                Retry own-model review
              </Button>
            ) : null}
            {showRetrySynthesis ? (
              <Button
                variant="outline"
                onClick={() => void handleRetry("synthesis")}
                disabled={busy !== null}
              >
                Retry synthesis
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
                runKind="investigation"
                workflowId={workflow.id}
                updatedAt={workflow.updatedAt}
              />
              <section>
                <h2 className="text-sm font-semibold text-foreground">Problem</h2>
                <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
                  {workflow.problemPrompt}
                </p>
                {workflow.branch ? (
                  <p className="mt-2 text-xs text-muted-foreground">Branch: {workflow.branch}</p>
                ) : null}
              </section>
              {synthesisThread && !synthesisThread.detailsLoaded ? (
                <section>
                  <h2 className="mb-3 text-sm font-semibold text-foreground">
                    Root Cause Analysis
                  </h2>
                  <div className="space-y-3 rounded-lg border border-border bg-background p-4">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-[92%]" />
                    <Skeleton className="h-4 w-[76%]" />
                  </div>
                </section>
              ) : null}
              {rcaText ? (
                <section>
                  <h2 className="mb-3 text-sm font-semibold text-foreground">
                    Root Cause Analysis
                  </h2>
                  <div className="rounded-lg border border-border bg-background p-4">
                    <ChatMarkdown text={rcaText} cwd={project?.cwd} />
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
