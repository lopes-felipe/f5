import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { useThreadDetail } from "../../lib/orchestrationReactQuery";
import { WORKFLOW_TYPE_DIALOG_LABEL } from "../../lib/workflowType";
import { readNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import type { ChatMessage } from "../../types";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import {
  canRetryCrossReview,
  canRetryFailedInvestigationPhase,
  canRetrySelfReview,
  canRetrySynthesis,
  statusLabel,
} from "./investigationWorkflowView.logic";
import { deriveInvestigationTimelinePhases } from "./investigationWorkflowSidebarTimeline";
import { WorkflowPageLayout, WorkflowPageNotFound } from "./WorkflowPageLayout";
import { WorkflowRunInspector } from "./WorkflowRunInspector";
import { WorkflowArtifactSection, WorkflowInputSection } from "./WorkflowSections";
import { overallStateFromPhases } from "./workflowTimelineTypes";

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
  const threadById = useMemo(
    () => new Map(threads.map((thread) => [thread.id, thread] as const)),
    [threads],
  );
  const timelinePhases = useMemo(
    () => (workflow ? deriveInvestigationTimelinePhases(workflow) : []),
    [workflow],
  );

  if (!workflow) {
    return <WorkflowPageNotFound />;
  }

  const synthesisThread = synthesisThreadId ? threadById.get(synthesisThreadId) : null;
  const rcaText =
    synthesisThread?.detailsLoaded === true
      ? combinedAssistantFeedback(
          synthesisThread.messages,
          workflow.synthesis.pinnedAssistantMessageId,
        )
      : null;
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
    </>
  );

  return (
    <WorkflowPageLayout
      projectId={workflow.projectId}
      workflowType="investigation"
      typeLabel={WORKFLOW_TYPE_DIALOG_LABEL.investigation}
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
      {synthesisThread && !synthesisThread.detailsLoaded ? (
        <WorkflowArtifactSection title="Root Cause Analysis">
          <div className="space-y-3">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-[92%]" />
            <Skeleton className="h-4 w-[76%]" />
          </div>
        </WorkflowArtifactSection>
      ) : null}
      {rcaText ? (
        <WorkflowArtifactSection title="Root Cause Analysis">
          <ChatMarkdown text={rcaText} cwd={project?.cwd} />
        </WorkflowArtifactSection>
      ) : null}
      <WorkflowInputSection label="Problem" text={workflow.problemPrompt} defaultOpen={!rcaText}>
        {workflow.branch ? (
          <p className="mt-2 text-ui text-muted-foreground">
            Branch: <span className="font-mono">{workflow.branch}</span>
          </p>
        ) : null}
      </WorkflowInputSection>
      <WorkflowRunInspector
        runKind="investigation"
        workflowId={workflow.id}
        updatedAt={workflow.updatedAt}
      />
    </WorkflowPageLayout>
  );
}
