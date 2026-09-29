import type { ProjectId, ThreadEnvMode } from "@t3tools/contracts";
import { queryOptions, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { nonDefaultThreadEnvMode, resolveThreadEnvMode } from "@t3tools/shared/threadEnvMode";

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
  return useCallback(
    async (
      projectId: ProjectId,
      options: ResolveProjectThreadEnvModeOptions = {},
    ): Promise<ThreadEnvMode> => {
      if (options.requested)
        return options.forceNonDefault
          ? nonDefaultThreadEnvMode(options.requested)
          : options.requested;
      await migrateLegacyClientSetting();
      const { settings } = await queryClient.fetchQuery(projectSettingsQueryOptions(projectId));
      return options.forceNonDefault
        ? nonDefaultThreadEnvMode(settings.defaultThreadEnvMode)
        : settings.defaultThreadEnvMode;
    },
    [queryClient],
  );
}
