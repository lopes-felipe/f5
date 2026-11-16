import { createFileRoute, useRouter, useRouterState } from "@tanstack/react-router";
import { isKnownProviderKind } from "@t3tools/contracts";
import { useEffect, useMemo } from "react";

import { useAppSettings } from "../appSettings";
import { RouteErrorView } from "../components/RouteErrorView";
import { AppTitlebar } from "../components/AppTitlebar";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { UsageDashboard } from "../components/usage/UsageDashboard";
import { SidebarInset } from "../components/ui/sidebar";
import {
  materializeUsageSearch,
  needsSearchNormalization,
  validateUsageSearch,
} from "../lib/usageSearch";

function UsageRouteView() {
  const { settings, updateSettings } = useAppSettings();
  useDocumentTitle("Usage");
  const search = Route.useSearch();
  const rawSearch = useRouterState({ select: (state) => state.location.search });
  const navigate = Route.useNavigate();
  const router = useRouter();
  const hiddenProviders = useMemo(
    () => settings.usageHiddenProviders.filter(isKnownProviderKind),
    [settings.usageHiddenProviders],
  );

  // Normalizing invalid or default values replaces the entry instead of pushing.
  useEffect(() => {
    if (needsSearchNormalization(rawSearch as Record<string, unknown>, search))
      void navigate({ search: () => search, replace: true });
  }, [navigate, rawSearch, search]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <AppTitlebar webVisibility="mobile-only" breadcrumb={[{ label: "Usage" }]} />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-none">
        <UsageDashboard
          search={search}
          defaults={{ tab: settings.usageTab, range: settings.usageRange }}
          hiddenProviders={hiddenProviders}
          onHiddenProvidersChange={(next) => updateSettings({ usageHiddenProviders: [...next] })}
          onBack={() => {
            if (router.history.canGoBack()) router.history.back();
            else void router.navigate({ to: "/" });
          }}
          onSearchChange={async (patch) => {
            // Pin the current entry's effective tab/range before the saved
            // defaults change, so Back restores what was on screen.
            const current = materializeUsageSearch(search, {
              tab: settings.usageTab,
              range: settings.usageRange,
            });
            if (current) await navigate({ search: () => current, replace: true });
            if (patch.tab) updateSettings({ usageTab: patch.tab });
            if (patch.range) updateSettings({ usageRange: patch.range });
            // User changes push history entries and preserve the other params.
            await navigate({
              search: (previous) => validateUsageSearch({ ...previous, ...patch }),
            });
          }}
        />
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/usage")({
  validateSearch: validateUsageSearch,
  component: UsageRouteView,
  errorComponent: RouteErrorView,
});
