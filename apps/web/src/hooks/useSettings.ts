import { projectSettingsQueryOptions } from "../lib/projectSettingsQuery";
import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { hashKey, replaceEqualDeep, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ServerSettings,
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  type ProjectSettingsResult,
  type ServerSettingsPatch,
  type ThreadEnvMode,
  type UnifiedSettings,
  type ProjectId,
} from "@t3tools/contracts";
import {
  pendingLegacyThreadEnvMode,
  readLegacyClientSetting,
  subscribePendingClientSettings,
} from "./useMigrateClientSettings";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import {
  AppSettingsSchema,
  type AppSettings,
  readAppSettingsSnapshot,
  subscribeAppSettings,
  updateAppSettings,
} from "../appSettings";
import { serverConfigQueryOptions, serverQueryKeys } from "../lib/serverReactQuery";
import { ensureNativeApi } from "../nativeApi";

const APP_SETTINGS_KEYS = new Set(Object.keys(AppSettingsSchema.fields));
const SERVER_SETTINGS_KEYS = new Set(
  Object.keys(ServerSettings.fields).filter((key) => !APP_SETTINGS_KEYS.has(key)),
);
export type UnifiedWebSettings = UnifiedSettings & AppSettings;

const SERVER_SETTINGS_FIELD_KEYS = Object.keys(ServerSettings.fields) as ReadonlyArray<
  keyof ServerSettings
>;

/**
 * The merged settings restricted to server-schema keys. Pass it to `useSettings` when a
 * component needs `ServerSettings`: a write to a web-only setting keeps its identity.
 */
export function selectServerSettings(settings: UnifiedWebSettings): ServerSettings {
  const selected: Partial<Record<keyof ServerSettings, unknown>> = {};
  for (const key of SERVER_SETTINGS_FIELD_KEYS) selected[key] = settings[key];
  return selected as ServerSettings;
}

export function mergeSettings(
  appSettings: AppSettings,
  serverSettings?: ServerSettings,
): UnifiedWebSettings {
  return {
    ...DEFAULT_UNIFIED_SETTINGS,
    ...serverSettings,
    ...appSettings,
  } as UnifiedWebSettings;
}

export function splitSettingsPatch(patch: Partial<UnifiedWebSettings>): {
  serverPatch: ServerSettingsPatch;
  appPatch: Partial<AppSettings>;
} {
  const serverPatch: Record<string, unknown> = {};
  const appPatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (APP_SETTINGS_KEYS.has(key)) {
      appPatch[key] = value;
    } else if (SERVER_SETTINGS_KEYS.has(key)) {
      serverPatch[key] = value;
    }
  }
  return {
    serverPatch: serverPatch as ServerSettingsPatch,
    appPatch: appPatch as Partial<AppSettings>,
  };
}

interface SettingsSources {
  readonly appSettings: AppSettings;
  readonly serverSettings: ServerSettings | undefined;
  readonly projectSettings: ProjectSettingsResult | undefined;
  readonly pendingThreadEnvMode: ThreadEnvMode | undefined;
}

function mergeSettingsSources(sources: SettingsSources): UnifiedWebSettings {
  const merged = mergeSettings(sources.appSettings, sources.serverSettings);
  if (sources.projectSettings) {
    for (const key of PROJECT_SCOPED_SERVER_SETTING_KEYS) {
      Object.assign(merged, { [key]: sources.projectSettings.settings[key] });
    }
  }
  // Show the default new threads actually get while its migration is pending.
  const pending =
    sources.serverSettings &&
    pendingLegacyThreadEnvMode(
      sources.projectSettings?.settings ?? sources.serverSettings,
      sources.projectSettings?.sources.defaultThreadEnvMode ?? "global",
      sources.pendingThreadEnvMode,
    );
  if (pending) Object.assign(merged, { defaultThreadEnvMode: pending });
  return merged;
}

/**
 * Merged web-local, server and project settings, narrowed by `selector`.
 * The selector runs against store snapshots before React decides to render,
 * so a component re-renders only when its selected value changes (compared
 * structurally, so object selections stay stable across unrelated writes).
 */
export function useSettings<T = UnifiedWebSettings>(
  selector?: (settings: UnifiedWebSettings) => T,
  projectId?: ProjectId,
): T {
  const queryClient = useQueryClient();
  // Observe both queries for fetching and garbage collection only; results
  // are read from the cache below so they do not re-render this component.
  useQuery({ ...serverConfigQueryOptions(), notifyOnChangeProps: [] });
  useQuery({
    ...projectSettingsQueryOptions(projectId ?? ("" as ProjectId)),
    enabled: !!projectId,
    notifyOnChangeProps: [],
  });
  const projectQueryHash = projectId
    ? hashKey(projectSettingsQueryOptions(projectId).queryKey)
    : null;

  const subscribe = useCallback(
    (listener: () => void) => {
      const configQueryHash = hashKey(serverQueryKeys.config());
      const unsubscribeAppSettings = subscribeAppSettings(listener);
      const unsubscribePending = subscribePendingClientSettings(listener);
      const unsubscribeQueries = queryClient.getQueryCache().subscribe((event) => {
        const queryHash = event.query.queryHash;
        if (queryHash === configQueryHash || queryHash === projectQueryHash) listener();
      });
      return () => {
        unsubscribeAppSettings();
        unsubscribePending();
        unsubscribeQueries();
      };
    },
    [projectQueryHash, queryClient],
  );

  // Memoizes on the source snapshots and the selector identity; inline
  // selectors re-run each render and structural sharing keeps the result.
  // The cache may also be written by a render React discards. That is
  // harmless: a value is only reused for the identical (merged, selector)
  // pair, and anything else is recomputed against it with `replaceEqualDeep`.
  const getSnapshot = useMemo(() => {
    let previous: { sources: SettingsSources; merged: UnifiedWebSettings } | null = null;
    let selected: { merged: UnifiedWebSettings; selector: unknown; value: T } | null = null;
    return (activeSelector: ((settings: UnifiedWebSettings) => T) | undefined): T => {
      const sources: SettingsSources = {
        appSettings: readAppSettingsSnapshot(),
        serverSettings: queryClient.getQueryData(serverConfigQueryOptions().queryKey)?.settings,
        projectSettings: projectId
          ? queryClient.getQueryData(projectSettingsQueryOptions(projectId).queryKey)
          : undefined,
        pendingThreadEnvMode: readLegacyClientSetting(),
      };
      if (
        !previous ||
        previous.sources.appSettings !== sources.appSettings ||
        previous.sources.serverSettings !== sources.serverSettings ||
        previous.sources.projectSettings !== sources.projectSettings ||
        previous.sources.pendingThreadEnvMode !== sources.pendingThreadEnvMode
      ) {
        previous = { sources, merged: mergeSettingsSources(sources) };
      }
      const { merged } = previous;
      if (selected && selected.merged === merged && selected.selector === activeSelector) {
        return selected.value;
      }
      const next = activeSelector ? activeSelector(merged) : (merged as T);
      const value = selected ? replaceEqualDeep(selected.value, next) : next;
      selected = { merged, selector: activeSelector, value };
      return value;
    };
  }, [projectId, queryClient]);
  const getSelectedSnapshot = () => getSnapshot(selector);

  return useSyncExternalStore(subscribe, getSelectedSnapshot, getSelectedSnapshot);
}

export function useUpdateSettings() {
  // Writes go straight to storage, so updating settings does not subscribe the caller.
  const queryClient = useQueryClient();
  const serverUpdateQueueRef = useRef<Promise<void>>(Promise.resolve());

  const updateSettings = useCallback(
    async (patch: Partial<UnifiedWebSettings>) => {
      const { serverPatch, appPatch } = splitSettingsPatch(patch);
      if (Object.keys(appPatch).length > 0) {
        updateAppSettings(appPatch);
      }
      if (Object.keys(serverPatch).length > 0) {
        const update = serverUpdateQueueRef.current.then(async () => {
          const settings = await ensureNativeApi().server.updateSettings(serverPatch);
          void queryClient.invalidateQueries({ queryKey: ["server", "project-settings"] });
          queryClient.setQueryData(serverQueryKeys.config(), (existing) =>
            existing ? { ...existing, settings } : existing,
          );
        });
        serverUpdateQueueRef.current = update.catch(() => undefined);
        await update;
      }
    },
    [queryClient],
  );

  return { updateSettings } as const;
}
