import type { OrchestrationEvent, WorkflowRunKind } from "@t3tools/contracts";
import type { QueryClient } from "@tanstack/react-query";

export const workflowDetailsQueryKey = (kind: WorkflowRunKind, id: string) =>
  ["workflow-platform", "details", kind, id] as const;

function identity(event: OrchestrationEvent): { kind: WorkflowRunKind; id: string } | null {
  switch (event.type) {
    case "project.workflow-created":
    case "project.workflow-upserted":
      return { kind: "planning", id: event.payload.workflow.id };
    case "project.workflow-deleted":
      return { kind: "planning", id: event.payload.workflowId };
    case "project.code-review-workflow-created":
    case "project.code-review-workflow-upserted":
      return { kind: "codeReview", id: event.payload.workflow.id };
    case "project.code-review-workflow-deleted":
      return { kind: "codeReview", id: event.payload.workflowId };
    case "project.investigation-workflow-created":
    case "project.investigation-workflow-upserted":
    case "project.debug-workflow-created":
    case "project.debug-workflow-upserted":
      return { kind: "investigation", id: event.payload.workflow.id };
    case "project.investigation-workflow-deleted":
    case "project.debug-workflow-deleted":
      return { kind: "investigation", id: event.payload.workflowId };
    default:
      return null;
  }
}

/** Heavy detail can change without changing the summary or its timestamp. */
export function invalidateWorkflowQueries(
  client: QueryClient,
  events?: ReadonlyArray<OrchestrationEvent>,
) {
  const keys = new Map<string, readonly string[]>();
  if (!events) keys.set("all", ["workflow-platform"]);
  else
    for (const event of events) {
      const run = identity(event);
      if (!run) continue;
      for (const detail of ["details", "inspection"]) {
        const key = ["workflow-platform", detail, run.kind, run.id];
        keys.set(JSON.stringify(key), key);
      }
    }
  return Promise.all(
    [...keys.values()].map(async (queryKey) => {
      // Cancel even a first fetch with no cached data; a late old response must
      // not replace the result fetched after this event or snapshot watermark.
      await client.cancelQueries({ queryKey });
      await client.invalidateQueries({ queryKey });
    }),
  );
}
