import type { ProjectId, ThreadEnvMode } from "@t3tools/contracts";
import { queryOptions, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { nonDefaultThreadEnvMode, resolveThreadEnvMode } from "@t3tools/shared/threadEnvMode";

import { useAppSettings } from "../appSettings";
import { ensureNativeApi } from "../nativeApi";
import { useStore } from "../store";

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

export function useProjectThreadEnvModeResolver() {
  const queryClient = useQueryClient();
  const projects = useStore((state) => state.projects);
  const { settings } = useAppSettings();

  return useCallback(
    async (
      projectId: ProjectId,
      options: ResolveProjectThreadEnvModeOptions = {},
    ): Promise<ThreadEnvMode> => {
      const projectDefault =
        projects.find((project) => project.id === projectId)?.defaultEnvMode ?? null;
      let configDefault: ThreadEnvMode | null = null;
      if (options.requested === undefined && projectDefault === null) {
        configDefault = await queryClient
          .fetchQuery(projectCheckedInConfigQueryOptions(projectId))
          .then((config) => config.defaultThreadEnvMode)
          .catch(() => null);
      }
      const resolved = resolveThreadEnvMode({
        requested: options.requested,
        projectDefault,
        globalDefault: configDefault ?? settings.defaultThreadEnvMode,
      });
      return options.forceNonDefault ? nonDefaultThreadEnvMode(resolved) : resolved;
    },
    [projects, queryClient, settings.defaultThreadEnvMode],
  );
}
