import { createFileRoute } from "@tanstack/react-router";

import { WorkflowView } from "../components/workflow/WorkflowView";
import { SidebarInset } from "../components/ui/sidebar";

function WorkflowRouteView() {
  const workflowId = Route.useParams({
    select: (params) => params.workflowId,
  });

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <WorkflowView workflowId={workflowId} />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/workflow/$workflowId")({
  component: WorkflowRouteView,
});
