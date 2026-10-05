import { createFileRoute } from "@tanstack/react-router";

import { AppTitlebar } from "../components/AppTitlebar";
import { HomeEmptyStatePanel } from "../components/onboarding/HomeEmptyStatePanel";
import { SidebarInset } from "../components/ui/sidebar";

export function ChatIndexRouteView() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <AppTitlebar webVisibility="mobile-only" breadcrumb={[{ label: "Home" }]} />
        <div className="flex flex-1 items-start justify-center overflow-y-auto">
          <HomeEmptyStatePanel />
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
