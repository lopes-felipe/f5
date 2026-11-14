import { cachedGlobalDraftSettings } from "./draftSettingsDefaults";
import { useStore } from "../store";
import type {
  ProjectCheckedInConfig,
  ProjectId,
  ProjectSettingsResult,
  ThreadEnvMode,
} from "@t3tools/contracts";
import { type QueryClient, queryOptions, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { nonDefaultThreadEnvMode } from "@t3tools/shared/threadEnvMode";

import { projectSettingsQueryOptions } from "./projectSettingsQuery";
import {
  migrateLegacyClientSetting,
  pendingLegacyThreadEnvMode,
  readLegacyClientSetting,
} from "../hooks/useMigrateClientSettings";
import { ensureNativeApi } from "../nativeApi";
import { getWsConnectionState } from "../wsConnectionState";

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

type ThreadEnvModeSource = ProjectSettingsResult["sources"]["defaultThreadEnvMode"];

/**
 * Where the workspace default comes from without the server, in the server's
 * precedence order, or `null` when a checked-in file may set it but is not cached.
 */
export function cachedProjectThreadEnvModeSource(
  projectId: ProjectId,
  checkedIn: ProjectCheckedInConfig | undefined,
): ThreadEnvModeSource | null {
  const global = cachedGlobalDraftSettings();
  if (global.projectSettingsOverrides[projectId]?.defaultThreadEnvMode !== undefined)
    return "project";
  const project = useStore.getState().projects.find((p) => p.id === projectId);
  if (project?.defaultEnvMode) return "legacy-project";
  if (!checkedIn) return null;
  if (checkedIn.settings?.defaultThreadEnvMode !== undefined || checkedIn.defaultThreadEnvMode)
    return checkedIn.sourceFile ?? "f5.json";
  return "global";
}

export async function resolveProjectThreadEnvMode(
  queryClient: QueryClient,
  projectId: ProjectId,
  options: ResolveProjectThreadEnvModeOptions = {},
): Promise<ThreadEnvMode> {
  if (options.requested)
    return options.forceNonDefault ? nonDefaultThreadEnvMode(options.requested) : options.requested;
  const readCached = () => {
    const cached = queryClient.getQueryData(projectSettingsQueryOptions(projectId).queryKey);
    const settings = cached?.settings ?? {
      ...cachedGlobalDraftSettings(),
      defaultThreadEnvMode: resolveCachedProjectThreadEnvMode(projectId),
    };
    const source =
      cached?.sources.defaultThreadEnvMode ??
      cachedProjectThreadEnvModeSource(
        projectId,
        queryClient.getQueryData(projectCheckedInConfigQueryOptions(projectId).queryKey),
      );
    return { settings, source };
  };
  const resolveMode = ({ settings, source }: ReturnType<typeof readCached>) => {
    const envMode = pendingLegacyThreadEnvMode(settings, source) ?? settings.defaultThreadEnvMode;
    return options.forceNonDefault ? nonDefaultThreadEnvMode(envMode) : envMode;
  };
  // Neither migration nor settings reads should queue behind an offline server.
  if (getWsConnectionState().phase !== "connected") return resolveMode(readCached());
  const hadPendingMigration = readLegacyClientSetting() !== undefined;
  await migrateLegacyClientSetting().catch(() => undefined);
  const query = projectSettingsQueryOptions(projectId);
  // A copy fetched before the migration landed would carry the old default,
  // and fetchQuery joins a request already in flight instead of starting one.
  if (hadPendingMigration) await queryClient.cancelQueries({ queryKey: query.queryKey });
  const { settings, source } = await queryClient
    .fetchQuery(hadPendingMigration ? { ...query, staleTime: 0 } : query)
    .then((result) => ({
      settings: result.settings,
      source: result.sources.defaultThreadEnvMode,
    }))
    .catch(readCached);
  return resolveMode({ settings, source });
}

export function useProjectThreadEnvModeResolver() {
  const queryClient = useQueryClient();
  return useCallback(
    (projectId: ProjectId, options?: ResolveProjectThreadEnvModeOptions) =>
      resolveProjectThreadEnvMode(queryClient, projectId, options),
    [queryClient],
  );
}
