import { createFileRoute } from "@tanstack/react-router";

import { CodeReviewWorkflowView } from "../components/workflow/CodeReviewWorkflowView";
import { SidebarInset } from "../components/ui/sidebar";

function CodeReviewWorkflowRouteView() {
  const workflowId = Route.useParams({
    select: (params) => params.workflowId,
  });

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <CodeReviewWorkflowView workflowId={workflowId} />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/code-review/$workflowId")({
  component: CodeReviewWorkflowRouteView,
});
