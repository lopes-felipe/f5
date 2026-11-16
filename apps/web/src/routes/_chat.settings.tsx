import { getSettingsItemDescriptor } from "../components/settings/settingsCategories";
import { SettingsScopePicker } from "../components/settings/ProjectSettingsScope";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { RouteErrorView } from "../components/RouteErrorView";

import { SettingsLayout } from "../components/settings/SettingsLayout";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { SettingsRouteContext } from "../components/settings/SettingsRouteContext";
import {
  isProjectSettingsCategory,
  resolveSettingsSearch,
  type SettingsSearch,
} from "../components/settings/settingsRouting";
import { useSettingsRouteState } from "../components/settings/useSettingsRouteState";

function SettingsRouteView() {
  const search = Route.useSearch();
  useDocumentTitle("Settings");
  const navigate = Route.useNavigate();
  const routeState = useSettingsRouteState({ projectId: search.project ?? null });

  return (
    <SettingsRouteContext.Provider value={routeState}>
      <SettingsLayout
        scopeHeader={
          <SettingsScopePicker
            projectId={search.project}
            onChange={(project) => {
              // Stay on the same page when it exists in the new scope.
              void navigate({
                search: (prev): SettingsSearch =>
                  project
                    ? {
                        category: isProjectSettingsCategory(prev.category)
                          ? prev.category
                          : "project",
                        project,
                      }
                    : { category: prev.category === "project" ? "projects" : prev.category },
              });
            }}
          />
        }
        projectId={search.project}
        projectName={routeState.selectedProject?.name}
        projectUnavailable={routeState.selectedProjectUnavailable}
        category={search.category}
        item={search.item}
        onCategoryChange={(category) => {
          void navigate({
            search: (prev) => {
              const { item: _previousItem, ...rest } = prev;
              return { ...rest, category };
            },
          });
        }}
        onItemChange={(item) => {
          const descriptor = getSettingsItemDescriptor(item);
          if (!descriptor) return;
          void navigate({
            search: (prev) => ({
              ...prev,
              category: descriptor.category,
              item: descriptor.id,
            }),
          });
        }}
      />
    </SettingsRouteContext.Provider>
  );
}

export const Route = createFileRoute("/_chat/settings")({
  // Accepts legacy category names, item IDs and the old `projectId` param, and
  // rewrites them to the canonical `category`/`item`/`project` search.
  validateSearch: (input): SettingsSearch => resolveSettingsSearch(input),
  // The router merges raw search params into the validated ones and never
  // rewrites the address bar, so replace legacy URLs once with the canonical form.
  beforeLoad: ({ location }) => {
    const raw = location.search as Record<string, unknown>;
    const canonical = resolveSettingsSearch(raw);
    const stale =
      "projectId" in raw ||
      (raw.category !== undefined && raw.category !== canonical.category) ||
      (raw.item !== undefined && raw.item !== canonical.item) ||
      (raw.project !== undefined && raw.project !== canonical.project);
    if (!stale) return;
    const {
      projectId: _projectId,
      category: _category,
      item: _item,
      project: _project,
      ...rest
    } = raw;
    throw redirect({ to: "/settings", search: { ...rest, ...canonical } as never, replace: true });
  },
  component: SettingsRouteView,
  errorComponent: RouteErrorView,
});
