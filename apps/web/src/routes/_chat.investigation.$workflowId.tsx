import { createFileRoute } from "@tanstack/react-router";

import { StartupWorkflowRouteSkeleton } from "../components/StartupLoadingState";
import { InvestigationWorkflowView } from "../components/workflow/InvestigationWorkflowView";
import { SidebarInset } from "../components/ui/sidebar";
import { useStartupReady } from "../lib/startupReady";

function InvestigationWorkflowRouteView() {
  const startupReady = useStartupReady();
  const workflowId = Route.useParams({
    select: (params) => params.workflowId,
  });

  if (!startupReady) {
    return <StartupWorkflowRouteSkeleton kind="investigation" />;
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <InvestigationWorkflowView workflowId={workflowId} />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/investigation/$workflowId")({
  component: InvestigationWorkflowRouteView,
});
