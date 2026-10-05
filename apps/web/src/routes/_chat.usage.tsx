import { createFileRoute } from "@tanstack/react-router";

import { AppTitlebar } from "../components/AppTitlebar";
import { UsageDashboard } from "../components/usage/UsageDashboard";
import { SidebarInset } from "../components/ui/sidebar";

function UsageRouteView() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <AppTitlebar webVisibility="mobile-only" breadcrumb={[{ label: "Usage" }]} />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-none">
        <UsageDashboard />
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/usage")({
  component: UsageRouteView,
});
