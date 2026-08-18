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

export function resolveProjectThreadEnvModeImmediately(input: {
  readonly options: ResolveProjectThreadEnvModeOptions;
  readonly projectDefault: ThreadEnvMode | null;
  readonly cachedConfigDefault: ThreadEnvMode | null;
  readonly globalDefault: ThreadEnvMode;
  readonly prefetchConfig: () => void;
}): ThreadEnvMode {
  let configDefault: ThreadEnvMode | null = null;
  if (input.options.requested === undefined && input.projectDefault === null) {
    configDefault = input.cachedConfigDefault;
    if (configDefault === null) input.prefetchConfig();
  }
  const resolved = resolveThreadEnvMode({
    requested: input.options.requested,
    projectDefault: input.projectDefault,
    globalDefault: configDefault ?? input.globalDefault,
  });
  return input.options.forceNonDefault ? nonDefaultThreadEnvMode(resolved) : resolved;
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
      const query = projectCheckedInConfigQueryOptions(projectId);
      return resolveProjectThreadEnvModeImmediately({
        options,
        projectDefault,
        cachedConfigDefault: queryClient.getQueryData(query.queryKey)?.defaultThreadEnvMode ?? null,
        globalDefault: settings.defaultThreadEnvMode,
        // A checked-in project config is useful, but reading it must never sit
        // on the critical path for opening a local draft. Prime the cache for
        // the next resolution while immediately using any value available.
        prefetchConfig: () => {
          void queryClient.prefetchQuery(query).catch(() => undefined);
        },
      });
    },
    [projects, queryClient, settings.defaultThreadEnvMode],
  );
}
