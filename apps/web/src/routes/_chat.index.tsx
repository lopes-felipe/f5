import { createFileRoute } from "@tanstack/react-router";

import { HomeEmptyStatePanel } from "../components/onboarding/HomeEmptyStatePanel";
import { isElectron } from "../env";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";

export function ChatIndexRouteView() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-muted-foreground/40">
        {!isElectron && (
          <header className="border-b border-border px-3 py-2 md:hidden">
            <div className="flex items-center gap-2">
              <SidebarTrigger className="size-7 shrink-0" />
              <span className="text-sm font-medium text-foreground">Threads</span>
            </div>
          </header>
        )}

        {isElectron && (
          <div className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5">
            <span className="text-xs text-muted-foreground/50">No active thread</span>
          </div>
        )}

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
