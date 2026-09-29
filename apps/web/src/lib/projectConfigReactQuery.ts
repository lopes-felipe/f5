import { cachedGlobalDraftSettings } from "./draftSettingsDefaults";
import { useStore } from "../store";
import type { ProjectId, ThreadEnvMode } from "@t3tools/contracts";
import { queryOptions, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { nonDefaultThreadEnvMode } from "@t3tools/shared/threadEnvMode";

import { projectSettingsQueryOptions } from "./projectSettingsQuery";
import { migrateLegacyClientSetting } from "../hooks/useMigrateClientSettings";
import { ensureNativeApi } from "../nativeApi";

const CHECKED_IN_PROJECT_CONFIG_STALE_TIME_MS = 5_000;

export const projectCheckedInConfigQueryOptions = (projectId: ProjectId) =>
  queryOptions({
    queryKey: ["projects", projectId, "checked-in-config"] as const,
    queryFn: () => ensureNativeApi().projects.getCheckedInConfig({ projectId }),
    staleTime: CHECKED_IN_PROJECT_CONFIG_STALE_TIME_MS,
  });

export interface ResolveProjectThreadEnvModeOptions {
  readonly requested?: ThreadEnvMode;
  readonly forceNonDefault?: boolean;
}

export function resolveCachedProjectThreadEnvMode(projectId: ProjectId): ThreadEnvMode {
  const global = cachedGlobalDraftSettings();
  const project = useStore.getState().projects.find((p) => p.id === projectId);
  return (
    global.projectSettingsOverrides[projectId]?.defaultThreadEnvMode ??
    project?.defaultEnvMode ??
    global.defaultThreadEnvMode
  );
}

export function useProjectThreadEnvModeResolver() {
  const queryClient = useQueryClient();
  return useCallback(
    async (
      projectId: ProjectId,
      options: ResolveProjectThreadEnvModeOptions = {},
    ): Promise<ThreadEnvMode> => {
      if (options.requested)
        return options.forceNonDefault
          ? nonDefaultThreadEnvMode(options.requested)
          : options.requested;
      await migrateLegacyClientSetting().catch(() => undefined);
      const { settings } = await queryClient
        .fetchQuery(projectSettingsQueryOptions(projectId))
        .catch(() => {
          const cached = queryClient.getQueryData(projectSettingsQueryOptions(projectId).queryKey);
          if (cached) return cached;
          const global = cachedGlobalDraftSettings();
          return {
            settings: {
              ...global,
              defaultThreadEnvMode: resolveCachedProjectThreadEnvMode(projectId),
            },
          };
        });
      return options.forceNonDefault
        ? nonDefaultThreadEnvMode(settings.defaultThreadEnvMode)
        : settings.defaultThreadEnvMode;
    },
    [queryClient],
  );
}
