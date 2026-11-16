import { workflowDetailsQueryKey } from "../lib/workflowQueries";
import type {
  PlanningWorkflow,
  CodeReviewWorkflow,
  InvestigationWorkflow,
  WorkflowRunKind,
} from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { ensureNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { Button } from "../components/ui/button";

interface Runs {
  planning: PlanningWorkflow;
  codeReview: CodeReviewWorkflow;
  investigation: InvestigationWorkflow;
}
const collections = {
  planning: "planningWorkflows",
  codeReview: "codeReviewWorkflows",
  investigation: "investigationWorkflows",
} as const;

export function useWorkflowDetails<K extends WorkflowRunKind>(kind: K, id: string) {
  const summary = useStore((store) =>
    store[collections[kind]].find((workflow) => workflow.id === id),
  );
  const key = workflowDetailsQueryKey(kind, id);
  // Full fixtures/legacy snapshots are already usable until the next run update.
  const existing =
    summary &&
    ((kind === "planning" && "requirementPrompt" in summary) ||
      (kind === "codeReview" && "reviewPrompt" in summary) ||
      (kind === "investigation" && "problemPrompt" in summary))
      ? (summary as Runs[K])
      : undefined;
  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      const before = useStore.getState()[collections[kind]].find((workflow) => workflow.id === id);
      const result = await ensureNativeApi().workflowPlatform.inspectRun({
        runKind: kind,
        workflowId: id,
        includeWorkflow: true,
      });
      if (before !== useStore.getState()[collections[kind]].find((workflow) => workflow.id === id))
        throw new Error(
          "Workflow changed while details were loading. Retry to read its current state.",
        );
      if (!result.workflowDetails || result.workflowDetails.runKind !== kind)
        throw new Error("Workflow details were unavailable.");
      return result.workflowDetails.workflow as Runs[K];
    },
    enabled: summary !== undefined && existing === undefined,
    staleTime: Infinity,
  });
  return {
    workflow: summary ? (existing ?? query.data) : undefined,
    missing: summary === undefined,
    error: query.error,
    retry: () => void query.refetch(),
  };
}

export function WorkflowDetailsStatus({
  missing,
  error,
  retry,
}: {
  missing: boolean;
  error: Error | null;
  retry: () => void;
}) {
  if (missing) return <p className="p-6">Workflow not found.</p>;
  return (
    <div className="p-6" role={error ? "alert" : "status"}>
      {error ? (
        <>
          Could not load this workflow.{" "}
          <Button size="xs" onClick={retry}>
            Try again
          </Button>
        </>
      ) : (
        "Loading workflow…"
      )}
    </div>
  );
}
