import { createFileRoute } from "@tanstack/react-router";

import { StartupWorkflowRouteSkeleton } from "../components/StartupLoadingState";
import { CodeReviewWorkflowView } from "../components/workflow/CodeReviewWorkflowView";
import { SidebarInset } from "../components/ui/sidebar";
import { useStartupReady } from "../lib/startupReady";

function CodeReviewWorkflowRouteView() {
  const startupReady = useStartupReady();
  const workflowId = Route.useParams({
    select: (params) => params.workflowId,
  });

  if (!startupReady) {
    return <StartupWorkflowRouteSkeleton kind="code-review" />;
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <CodeReviewWorkflowView workflowId={workflowId} />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/code-review/$workflowId")({
  component: CodeReviewWorkflowRouteView,
});
