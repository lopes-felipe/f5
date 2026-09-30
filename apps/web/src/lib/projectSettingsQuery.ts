import { rememberDraftSettings } from "./draftSettingsDefaults";
import { queryOptions } from "@tanstack/react-query";
import type { ProjectId } from "@t3tools/contracts";
import { ensureNativeApi } from "../nativeApi";

export const projectSettingsQueryOptions = (projectId: ProjectId) =>
  queryOptions({
    queryKey: ["server", "project-settings", projectId] as const,
    queryFn: async () => {
      const result = await ensureNativeApi().server.getProjectSettings({ projectId });
      rememberDraftSettings(result.settings, projectId);
      return result;
    },
    staleTime: 5_000,
  });
