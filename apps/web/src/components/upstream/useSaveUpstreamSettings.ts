import type { ProjectId, UpstreamPortsSettings } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { projectSettingsQueryOptions, PROJECT_SETTINGS_QUERY_KEY } from "../../lib/projectSettingsQuery";
import { invalidateUpstreamPorts } from "../../lib/upstreamPortsReactQuery";
import { ensureNativeApi } from "../../nativeApi";
import { upstreamSettingsOverrides } from "./upstreamPage.logic";

export function useSaveUpstreamSettings(projectId: ProjectId | null) {
  const queryClient = useQueryClient();
  const projectSettings = useQuery({ ...projectSettingsQueryOptions(projectId ?? ("" as ProjectId)), enabled: projectId !== null });
  const [saving, setSaving] = useState(false);
  const save = async (patch: Partial<UpstreamPortsSettings>) => {
    const loaded = projectSettings.data;
    if (!loaded || !projectId) return;
    setSaving(true);
    try {
      await ensureNativeApi().server.updateSettings({
        projectSettingsOverrides: {
          [projectId]: upstreamSettingsOverrides(loaded.overrides, loaded.settings.upstreamPorts, patch),
        },
      });
      await queryClient.invalidateQueries({ queryKey: PROJECT_SETTINGS_QUERY_KEY });
      await invalidateUpstreamPorts(queryClient);
    } finally { setSaving(false); }
  };
  return { save, saving, projectSettings };
}
