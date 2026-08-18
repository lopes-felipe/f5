import { useCallback, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ServerSettings, type ServerSettingsPatch, type UnifiedSettings } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { AppSettingsSchema, type AppSettings, useAppSettings } from "../appSettings";
import { serverConfigQueryOptions, serverQueryKeys } from "../lib/serverReactQuery";
import { ensureNativeApi } from "../nativeApi";

const APP_SETTINGS_KEYS = new Set(Object.keys(AppSettingsSchema.fields));
const SERVER_SETTINGS_KEYS = new Set(
  Object.keys(ServerSettings.fields).filter((key) => !APP_SETTINGS_KEYS.has(key)),
);
export type UnifiedWebSettings = UnifiedSettings & AppSettings;

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

export function useSettings<T = UnifiedWebSettings>(
  selector?: (settings: UnifiedWebSettings) => T,
): T {
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
          queryClient.setQueryData(serverQueryKeys.config(), (existing) =>
            existing ? { ...existing, settings } : existing,
          );
        });
        serverUpdateQueueRef.current = update.catch(() => undefined);
        await update;
      }
    },
    [queryClient, updateAppSettings],
  );

  return { updateSettings } as const;
}
