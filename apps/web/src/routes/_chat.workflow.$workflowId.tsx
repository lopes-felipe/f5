import { createFileRoute } from "@tanstack/react-router";

import { StartupWorkflowRouteSkeleton } from "../components/StartupLoadingState";
import { WorkflowView } from "../components/workflow/WorkflowView";
import { SidebarInset } from "../components/ui/sidebar";
import { useStartupReady } from "../lib/startupReady";

function WorkflowRouteView() {
  const startupReady = useStartupReady();
  const workflowId = Route.useParams({
    select: (params) => params.workflowId,
  });

  if (!startupReady) {
    return <StartupWorkflowRouteSkeleton kind="planning" />;
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <WorkflowView workflowId={workflowId} />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/workflow/$workflowId")({
  component: WorkflowRouteView,
});
