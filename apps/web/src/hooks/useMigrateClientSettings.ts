import type { MigrateClientSettingInput } from "@t3tools/contracts";
import { rememberDraftSettings } from "../lib/draftSettingsDefaults";
import { useQuery } from "@tanstack/react-query";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { APP_SETTINGS_STORAGE_KEY } from "../appSettings";
import { ensureNativeApi } from "../nativeApi";
import { serverQueryKeys } from "../lib/serverReactQuery";

export function readLegacyClientSetting(): "local" | "worktree" | undefined {
  try {
    const raw = JSON.parse(localStorage.getItem(APP_SETTINGS_STORAGE_KEY) ?? "{}");
    return raw.defaultThreadEnvMode === "local" || raw.defaultThreadEnvMode === "worktree"
      ? raw.defaultThreadEnvMode
      : undefined;
  } catch {
    return undefined;
  }
}

function readLegacyClientSettings(): MigrateClientSettingInput[] {
  const inputs: MigrateClientSettingInput[] = [];
  const env = readLegacyClientSetting();
  if (env !== undefined) inputs.push({ key: "defaultThreadEnvMode", value: env });
  try {
    const raw = JSON.parse(localStorage.getItem(APP_SETTINGS_STORAGE_KEY) ?? "{}");
    if (typeof raw.enableAssistantStreaming === "boolean")
      inputs.push({ key: "enableAssistantStreaming", value: raw.enableAssistantStreaming });
  } catch {
    /* Keep malformed local settings untouched. */
  }
  return inputs;
}
let migration: Promise<void> | undefined;
export function migrateLegacyClientSetting(inputs = readLegacyClientSettings()): Promise<void> {
  if (migration) return migration;
  if (inputs.length === 0) return Promise.resolve();
  migration = (async () => {
    for (const input of inputs) {
      await ensureNativeApi().server.migrateClientSetting(input);
      const raw = JSON.parse(localStorage.getItem(APP_SETTINGS_STORAGE_KEY) ?? "{}");
      delete raw[input.key];
      localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify(raw));
    }
  })().finally(() => {
    migration = undefined;
  });
  return migration;
}

export function useMigrateClientSettings() {
  const legacy = useRef(readLegacyClientSettings());
  const client = useQueryClient();
  const config = useQuery(serverConfigQueryOptions());
  useEffect(() => {
    if (config.data?.settings) rememberDraftSettings(config.data.settings);
  }, [config.data?.settings]);
  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout>;
    const run = () => {
      void migrateLegacyClientSetting(legacy.current)
        .then(() => {
          if (!cancelled) void client.invalidateQueries({ queryKey: serverQueryKeys.config() });
        })
        .catch(() => {
          if (!cancelled) retry = setTimeout(run, 5000);
        });
    };
    run();
    return () => {
      cancelled = true;
      clearTimeout(retry);
    };
  }, [client]);
}
