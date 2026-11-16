import type {
  MigrateClientSettingInput,
  ProjectSettingsResult,
  ServerSettings,
  ThreadEnvMode,
} from "@t3tools/contracts";
import { rememberDraftSettings } from "../lib/draftSettingsDefaults";
import { useQuery } from "@tanstack/react-query";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { APP_SETTINGS_STORAGE_KEY } from "../appSettings";
import { ensureNativeApi } from "../nativeApi";
import { serverQueryKeys } from "../lib/serverReactQuery";
import { PROJECT_SETTINGS_QUERY_KEY } from "../lib/projectSettingsQuery";

/**
 * Legacy values awaiting server acknowledgement. App-settings writes re-encode
 * the schema and drop unknown keys, so values wait here instead of there.
 */
export const PENDING_CLIENT_SETTINGS_STORAGE_KEY = "t3code:pending-client-settings:v1";
const LEGACY_KEYS = ["defaultThreadEnvMode", "enableAssistantStreaming"] as const;

function readStoredObject(key: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  } catch {
    return null;
  }
}

function toInputs(values: Record<string, unknown>): MigrateClientSettingInput[] {
  const inputs: MigrateClientSettingInput[] = [];
  const env = values.defaultThreadEnvMode;
  if (env === "local" || env === "worktree")
    inputs.push({ key: "defaultThreadEnvMode", value: env });
  if (typeof values.enableAssistantStreaming === "boolean")
    inputs.push({ key: "enableAssistantStreaming", value: values.enableAssistantStreaming });
  return inputs;
}

type LegacyKey = MigrateClientSettingInput["key"];

/**
 * This session's unacknowledged values. Storage can lose them before the
 * server takes them (a full pending key leaves them in app settings, where the
 * next app-settings write drops them), so memory is the fallback until then.
 */
const unacknowledged = new Map<LegacyKey, MigrateClientSettingInput>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribePendingClientSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Collects legacy values from storage and moves any still in app settings to
 * the pending key. Idempotent; call it before anything rewrites app settings.
 */
export function stageLegacyClientSettings(): MigrateClientSettingInput[] {
  const pending = readStoredObject(PENDING_CLIENT_SETTINGS_STORAGE_KEY) ?? {};
  // Malformed app settings stay untouched.
  const app = readStoredObject(APP_SETTINGS_STORAGE_KEY);
  const fromApp = app ? toInputs(app) : [];
  // Values still in app settings are newer than the pending copy: staging
  // removes them, so only an older build can have written them since.
  const stored = toInputs({
    ...pending,
    ...Object.fromEntries(fromApp.map((input) => [input.key, input.value])),
  });
  let changed = false;
  for (const input of stored) {
    if (unacknowledged.get(input.key)?.value === input.value) continue;
    unacknowledged.set(input.key, input);
    changed = true;
  }
  if (app && fromApp.length > 0) {
    try {
      localStorage.setItem(
        PENDING_CLIENT_SETTINGS_STORAGE_KEY,
        JSON.stringify(Object.fromEntries([...unacknowledged].map(([key, i]) => [key, i.value]))),
      );
      for (const key of LEGACY_KEYS) delete app[key];
      localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify(app));
    } catch {
      /* Storage is full or blocked; memory keeps the values for this session. */
    }
  }
  if (changed) notify();
  return [...unacknowledged.values()];
}

/** The staged workspace default awaiting the server. Reads memory only. */
export function readLegacyClientSetting(): ThreadEnvMode | undefined {
  const input = unacknowledged.get("defaultThreadEnvMode");
  return input?.key === "defaultThreadEnvMode" ? input.value : undefined;
}

type ThreadEnvModeSource = ProjectSettingsResult["sources"]["defaultThreadEnvMode"];

/**
 * The pending workspace default, when the server will accept it: it applies
 * only the first migration per key, and project-level values outrank the
 * global default it fills. `null` means the source is unknown, so it never applies.
 */
export function pendingLegacyThreadEnvMode(
  settings: ServerSettings,
  source: ThreadEnvModeSource | null,
  pending = readLegacyClientSetting(),
): ThreadEnvMode | undefined {
  if (settings.clientSettingMigrations.defaultThreadEnvMode) return undefined;
  if (source !== "global" && source !== "default") return undefined;
  return pending;
}

function forgetLegacyClientSetting(key: LegacyKey): void {
  unacknowledged.delete(key);
  notify();
  for (const storageKey of [PENDING_CLIENT_SETTINGS_STORAGE_KEY, APP_SETTINGS_STORAGE_KEY]) {
    const stored = readStoredObject(storageKey);
    if (!stored || !(key in stored)) continue;
    delete stored[key];
    if (storageKey === PENDING_CLIENT_SETTINGS_STORAGE_KEY && Object.keys(stored).length === 0)
      localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, JSON.stringify(stored));
  }
}

let migration: Promise<void> | undefined;
export function migrateLegacyClientSetting(): Promise<void> {
  if (migration) return migration;
  const inputs = stageLegacyClientSettings();
  if (inputs.length === 0) return Promise.resolve();
  migration = (async () => {
    for (const input of inputs) {
      await ensureNativeApi().server.migrateClientSetting(input);
      forgetLegacyClientSetting(input.key);
    }
  })().finally(() => {
    migration = undefined;
  });
  return migration;
}

export function useMigrateClientSettings() {
  // Staging during the first render moves legacy values out of app settings
  // before any effect can rewrite them; the lazy initializer runs it once.
  useState(stageLegacyClientSettings);
  const client = useQueryClient();
  const config = useQuery(serverConfigQueryOptions());
  useEffect(() => {
    if (config.data?.settings) rememberDraftSettings(config.data.settings);
  }, [config.data?.settings]);
  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout>;
    const run = () => {
      void migrateLegacyClientSetting()
        .then(() => {
          if (cancelled) return;
          void client.invalidateQueries({ queryKey: serverQueryKeys.config() });
          // Project settings resolve the migrated keys as well.
          void client.invalidateQueries({ queryKey: PROJECT_SETTINGS_QUERY_KEY });
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
