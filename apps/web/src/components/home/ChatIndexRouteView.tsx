import { AppTitlebar } from "../AppTitlebar";
import { HomeEmptyStatePanel } from "../onboarding/HomeEmptyStatePanel";
import { SidebarInset } from "../ui/sidebar";

/**
 * The home route's view. It lives outside the route file because a route file
 * that exports its component cannot be code split, which kept the whole home
 * screen in the initial bundle.
 */
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
