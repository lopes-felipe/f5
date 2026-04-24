import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { useStore } from "../../store";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { WorkflowTimelinePhaseList } from "./WorkflowTimelinePhaseList";
import { WorkflowImplementDialog } from "./WorkflowImplementDialog";
import { resolveApprovedMergedPlanMarkdown } from "./workflowUtils";
import { deriveTimelinePhases } from "./workflowSidebarTimeline";

function statusLabel(workflow: {
  readonly branchA: { readonly status: string };
  readonly branchB: { readonly status: string };
  readonly merge: { readonly status: string };
  readonly implementation: { readonly status: string } | null;
}) {
  if (
    workflow.branchA.status === "error" ||
    workflow.branchB.status === "error" ||
    workflow.merge.status === "error" ||
    workflow.implementation?.status === "error"
  ) {
    return "Error";
  }
  if (workflow.implementation) {
    switch (workflow.implementation.status) {
      case "implementing":
        return "Implementing";
      case "implemented":
        return "Implementation done";
      case "code_reviews_requested":
        return "Code reviewing";
      case "code_reviews_saved":
      case "applying_reviews":
        return "Applying review feedback";
      case "completed":
        return "Completed";
      default:
        break;
    }
  }
  if (workflow.merge.status === "merged") {
    return "Merged";
  }
  if (workflow.merge.status === "manual_review") {
    return "Manual review";
  }
  if (workflow.merge.status === "in_progress") {
    return "Merging";
  }
  if (workflow.branchA.status === "plan_saved" && workflow.branchB.status === "plan_saved") {
    return "Plans drafted";
  }
  if (workflow.branchA.status === "revised" && workflow.branchB.status === "revised") {
    return "Ready to merge";
  }
  if (workflow.branchA.status === "reviews_saved" || workflow.branchB.status === "reviews_saved") {
    return "Revising";
  }
  if (
    workflow.branchA.status === "reviews_requested" ||
    workflow.branchB.status === "reviews_requested"
  ) {
    return "Reviewing";
  }
  return "Authoring";
}

export function WorkflowView(props: { workflowId: string }) {
  const navigate = useNavigate();
  const [implementDialogOpen, setImplementDialogOpen] = useState(false);
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
  const canStartImplementation =
    workflow.merge.status === "manual_review" && !workflow.implementation;
  const threadById = new Map(threads.map((thread) => [thread.id, thread] as const));
  const timelinePhases = deriveTimelinePhases(workflow);
  const formattedCost =
    workflow.totalCostUsd <= 0
      ? null
      : workflow.totalCostUsd < 0.01
        ? "<$0.01"
        : `$${workflow.totalCostUsd.toFixed(2)}`;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="border-b border-border px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Workflow</p>
            <h1 className="mt-1 text-2xl font-semibold text-foreground">{workflow.title}</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {statusLabel(workflow)}
              {formattedCost ? ` · ${formattedCost}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {canStartImplementation ? (
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
        open={implementDialogOpen}
        workflow={workflow}
        onOpenChange={setImplementDialogOpen}
      />
    </div>
  );
}
