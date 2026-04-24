import { createFileRoute } from "@tanstack/react-router";

import { SettingsLayout } from "../components/settings/SettingsLayout";
import { SettingsRouteContext } from "../components/settings/SettingsRouteContext";
import {
  isSettingsCategory,
  type SettingsCategory,
} from "../components/settings/settingsCategories";
import { useSettingsRouteState } from "../components/settings/useSettingsRouteState";

function SettingsRouteView() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const routeState = useSettingsRouteState();

  return (
    <SettingsRouteContext.Provider value={routeState}>
      <SettingsLayout
        category={search.category}
        onCategoryChange={(category) => {
          void navigate({
            search: (prev) => ({ ...prev, category }),
          });
        }}
      />
    </SettingsRouteContext.Provider>
  );
}

export const Route = createFileRoute("/_chat/settings")({
  validateSearch: (input): { category: SettingsCategory } => {
    const raw = (input as { category?: unknown }).category;
    return {
      category: isSettingsCategory(raw) ? raw : "general",
    };
  },
  component: SettingsRouteView,
});
