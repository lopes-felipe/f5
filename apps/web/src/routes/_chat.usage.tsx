import { createFileRoute } from "@tanstack/react-router";

import { UsageDashboard } from "../components/usage/UsageDashboard";
import { SidebarInset } from "../components/ui/sidebar";

function UsageRouteView() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-y-auto overscroll-y-none bg-background text-foreground">
      <UsageDashboard />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/usage")({
  component: UsageRouteView,
});
