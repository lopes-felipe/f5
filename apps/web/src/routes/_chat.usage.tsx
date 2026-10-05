import { useAppSettings } from "../appSettings";
import { createFileRoute } from "@tanstack/react-router";

import { AppTitlebar } from "../components/AppTitlebar";
import { UsageDashboard } from "../components/usage/UsageDashboard";
import { SidebarInset } from "../components/ui/sidebar";

function UsageRouteView() {
  const { settings, updateSettings } = useAppSettings();
  const { tab } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <AppTitlebar webVisibility="mobile-only" breadcrumb={[{ label: "Usage" }]} />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-none">
        <UsageDashboard
          tab={tab ?? settings.usageTab}
          onTabChange={(next) => {
            updateSettings({ usageTab: next });
            void navigate({ search: { tab: next }, replace: true });
          }}
        />
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/usage")({
  validateSearch: (search: Record<string, unknown>): { tab?: "activity" | "limits" } =>
    search.tab === "activity" || search.tab === "limits" ? { tab: search.tab } : {},
  component: UsageRouteView,
});
