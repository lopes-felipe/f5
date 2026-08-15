import { ProjectId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback } from "react";

import { SettingsLayout } from "../components/settings/SettingsLayout";
import { SettingsRouteContext } from "../components/settings/SettingsRouteContext";
import {
  getSettingsItemDescriptor,
  isSettingsCategory,
  resolveSettingsProjectIdFromSearch,
  type SettingsCategory,
} from "../components/settings/settingsCategories";
import { useSettingsRouteState } from "../components/settings/useSettingsRouteState";

function SettingsRouteView() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const handleProjectIdChange = useCallback(
    (projectId: ProjectId | null) => {
      void navigate({
        replace: true,
        search: (prev) => {
          const { projectId: _previousProjectId, ...rest } = prev;
          return projectId ? { ...rest, projectId } : rest;
        },
      });
    },
    [navigate],
  );
  const routeState = useSettingsRouteState({
    projectSelection: {
      projectId: search.projectId ?? null,
      onProjectIdChange: handleProjectIdChange,
    },
  });

  return (
    <SettingsRouteContext.Provider value={routeState}>
      <SettingsLayout
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
  validateSearch: (
    input,
  ): {
    category: SettingsCategory;
    item?: string;
    projectId?: ProjectId;
  } => {
    const raw = input as { category?: unknown; item?: unknown; projectId?: unknown };
    const item = getSettingsItemDescriptor(raw.item);
    const projectId = resolveSettingsProjectIdFromSearch(raw);
    return {
      category: item?.category ?? (isSettingsCategory(raw.category) ? raw.category : "general"),
      ...(item ? { item: item.id } : {}),
      ...(projectId ? { projectId } : {}),
    };
  },
  component: SettingsRouteView,
});
