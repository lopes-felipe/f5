import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ServerSettings, type ServerSettingsPatch, type UnifiedSettings } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { type AppSettings, useAppSettings } from "../appSettings";
import { serverConfigQueryOptions, serverQueryKeys } from "../lib/serverReactQuery";
import { ensureNativeApi } from "../nativeApi";

const SERVER_SETTINGS_KEYS = new Set(Object.keys(ServerSettings.fields));

function mergeSettings(appSettings: AppSettings, serverSettings?: ServerSettings): UnifiedSettings {
  return {
    ...DEFAULT_UNIFIED_SETTINGS,
    ...serverSettings,
    enableAssistantStreaming: appSettings.enableAssistantStreaming,
    defaultThreadEnvMode: appSettings.defaultThreadEnvMode,
    addProjectBaseDirectory: appSettings.addProjectBaseDirectory,
    timestampFormat: appSettings.timestampFormat,
    confirmThreadDelete: appSettings.confirmThreadDelete,
    favorites: appSettings.favorites,
    providerModelPreferences: appSettings.providerModelPreferences,
  };
}

function splitSettingsPatch(patch: Partial<UnifiedSettings>): {
  serverPatch: ServerSettingsPatch;
  appPatch: Partial<AppSettings>;
} {
  const serverPatch: Record<string, unknown> = {};
  const appPatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (SERVER_SETTINGS_KEYS.has(key)) {
      serverPatch[key] = value;
    }
    if (
      key === "enableAssistantStreaming" ||
      key === "defaultThreadEnvMode" ||
      key === "addProjectBaseDirectory" ||
      key === "timestampFormat" ||
      key === "confirmThreadDelete" ||
      key === "favorites" ||
      key === "providerModelPreferences"
    ) {
      appPatch[key] = value;
    }
  }
  return {
    serverPatch: serverPatch as ServerSettingsPatch,
    appPatch: appPatch as Partial<AppSettings>,
  };
}

export function useSettings<T = UnifiedSettings>(selector?: (settings: UnifiedSettings) => T): T {
  const { settings: appSettings } = useAppSettings();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const merged = useMemo(
    () => mergeSettings(appSettings, serverConfigQuery.data?.settings),
    [appSettings, serverConfigQuery.data?.settings],
  );
  return useMemo(() => (selector ? selector(merged) : (merged as T)), [merged, selector]);
}

export function useUpdateSettings() {
  const { updateSettings: updateAppSettings } = useAppSettings();
  const queryClient = useQueryClient();

  const updateSettings = useCallback(
    async (patch: Partial<UnifiedSettings>) => {
      const { serverPatch, appPatch } = splitSettingsPatch(patch);
      if (Object.keys(appPatch).length > 0) {
        updateAppSettings(appPatch);
      }
      if (Object.keys(serverPatch).length > 0) {
        const settings = await ensureNativeApi().server.updateSettings(serverPatch);
        queryClient.setQueryData(serverQueryKeys.config(), (existing) =>
          existing ? { ...existing, settings } : existing,
        );
      }
    },
    [queryClient, updateAppSettings],
  );

  return { updateSettings } as const;
}
