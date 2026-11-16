import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { APP_SETTINGS_STORAGE_KEY } from "../appSettings";
import {
  migrateLegacyClientSetting,
  PENDING_CLIENT_SETTINGS_STORAGE_KEY,
  pendingLegacyThreadEnvMode,
  readLegacyClientSetting,
  stageLegacyClientSettings,
} from "./useMigrateClientSettings";
const api = vi.hoisted(() => ({ migrateClientSetting: vi.fn() }));
vi.mock("../nativeApi", () => ({ ensureNativeApi: () => ({ server: api }) }));
afterEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
});
it("does not migrate an absent browser key", async () => {
  localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ tasksPanelAutoOpen: true }));
  expect(readLegacyClientSetting()).toBeUndefined();
  await migrateLegacyClientSetting();
  expect(api.migrateClientSetting).not.toHaveBeenCalled();
});
it("migrates explicit local once and removes only that key after acknowledgement", async () => {
  localStorage.setItem(
    APP_SETTINGS_STORAGE_KEY,
    JSON.stringify({ defaultThreadEnvMode: "local", tasksPanelAutoOpen: true }),
  );
  let finish!: () => void;
  api.migrateClientSetting.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const first = migrateLegacyClientSetting();
  const second = migrateLegacyClientSetting();
  expect(api.migrateClientSetting).toHaveBeenCalledTimes(1);
  expect(readLegacyClientSetting()).toBe("local");
  finish();
  await Promise.all([first, second]);
  expect(JSON.parse(localStorage.getItem(APP_SETTINGS_STORAGE_KEY)!)).toEqual({
    tasksPanelAutoOpen: true,
  });
});
it("retains the value after a failed request and retries without overwriting another client's winner", async () => {
  localStorage.setItem(
    APP_SETTINGS_STORAGE_KEY,
    JSON.stringify({ defaultThreadEnvMode: "worktree" }),
  );
  api.migrateClientSetting.mockRejectedValueOnce(new Error("Disconnected"));
  await expect(migrateLegacyClientSetting()).rejects.toThrow("Disconnected");
  expect(readLegacyClientSetting()).toBe("worktree");
  api.migrateClientSetting.mockResolvedValueOnce({ applied: false, currentValue: "local" });
  await migrateLegacyClientSetting();
  expect(readLegacyClientSetting()).toBeUndefined();
});

it("keeps an unacknowledged value when app settings are rewritten without it", async () => {
  localStorage.setItem(
    APP_SETTINGS_STORAGE_KEY,
    JSON.stringify({ defaultThreadEnvMode: "worktree", tasksPanelAutoOpen: true }),
  );
  api.migrateClientSetting.mockRejectedValueOnce(new Error("Sync pending"));
  await expect(migrateLegacyClientSetting()).rejects.toThrow("Sync pending");
  // An app-settings write re-encodes the schema, which has no legacy keys.
  localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ tasksPanelAutoOpen: false }));
  expect(readLegacyClientSetting()).toBe("worktree");
  api.migrateClientSetting.mockResolvedValueOnce({ applied: true, currentValue: "worktree" });
  await migrateLegacyClientSetting();
  expect(api.migrateClientSetting).toHaveBeenLastCalledWith({
    key: "defaultThreadEnvMode",
    value: "worktree",
  });
  expect(readLegacyClientSetting()).toBeUndefined();
  expect(localStorage.getItem(PENDING_CLIENT_SETTINGS_STORAGE_KEY)).toBeNull();
  expect(JSON.parse(localStorage.getItem(APP_SETTINGS_STORAGE_KEY)!)).toEqual({
    tasksPanelAutoOpen: false,
  });
});

it("retries both values when the pending key cannot be written and app settings are rewritten", async () => {
  localStorage.setItem(
    APP_SETTINGS_STORAGE_KEY,
    JSON.stringify({
      defaultThreadEnvMode: "worktree",
      enableAssistantStreaming: false,
      tasksPanelAutoOpen: true,
    }),
  );
  const setItem = Storage.prototype.setItem;
  const quota = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    key: string,
    value: string,
  ) {
    if (key === PENDING_CLIENT_SETTINGS_STORAGE_KEY)
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    return setItem.call(this, key, value);
  });
  try {
    api.migrateClientSetting.mockRejectedValueOnce(new Error("Sync pending"));
    await expect(migrateLegacyClientSetting()).rejects.toThrow("Sync pending");
    expect(localStorage.getItem(PENDING_CLIENT_SETTINGS_STORAGE_KEY)).toBeNull();
    // The next app-settings write drops the keys the pending copy failed to save.
    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ tasksPanelAutoOpen: false }));
    api.migrateClientSetting.mockResolvedValue({ applied: true, currentValue: true });
    await migrateLegacyClientSetting();
    expect(api.migrateClientSetting.mock.calls.slice(1)).toEqual([
      [{ key: "defaultThreadEnvMode", value: "worktree" }],
      [{ key: "enableAssistantStreaming", value: false }],
    ]);
    expect(readLegacyClientSetting()).toBeUndefined();
  } finally {
    quota.mockRestore();
  }
});

it("prefers a value an older build wrote to app settings over the pending copy", async () => {
  localStorage.setItem(
    PENDING_CLIENT_SETTINGS_STORAGE_KEY,
    JSON.stringify({ defaultThreadEnvMode: "local" }),
  );
  localStorage.setItem(
    APP_SETTINGS_STORAGE_KEY,
    JSON.stringify({ defaultThreadEnvMode: "worktree" }),
  );
  expect(stageLegacyClientSettings()).toEqual([{ key: "defaultThreadEnvMode", value: "worktree" }]);
  expect(JSON.parse(localStorage.getItem(PENDING_CLIENT_SETTINGS_STORAGE_KEY)!)).toEqual({
    defaultThreadEnvMode: "worktree",
  });
  api.migrateClientSetting.mockResolvedValueOnce({ applied: true, currentValue: "worktree" });
  await migrateLegacyClientSetting();
  expect(readLegacyClientSetting()).toBeUndefined();
});

it("uses a pending workspace default only where the server would apply it", () => {
  const pending = "worktree" as const;
  expect(pendingLegacyThreadEnvMode(DEFAULT_SERVER_SETTINGS, "global", pending)).toBe("worktree");
  expect(pendingLegacyThreadEnvMode(DEFAULT_SERVER_SETTINGS, "default", pending)).toBe("worktree");
  // Project-level values outrank the global default the migration fills.
  for (const source of ["project", "f5.json", "t3.json", "legacy-project"] as const)
    expect(pendingLegacyThreadEnvMode(DEFAULT_SERVER_SETTINGS, source, pending)).toBeUndefined();
  // An unknown source might be a checked-in file.
  expect(pendingLegacyThreadEnvMode(DEFAULT_SERVER_SETTINGS, null, pending)).toBeUndefined();
  // The server keeps the first migration for a key, so a later one loses.
  expect(
    pendingLegacyThreadEnvMode(
      {
        ...DEFAULT_SERVER_SETTINGS,
        clientSettingMigrations: { defaultThreadEnvMode: "2026-10-16T00:00:00.000Z" },
      },
      "global",
      pending,
    ),
  ).toBeUndefined();
});

it("preserves an explicit disabled streaming preference during migration", async () => {
  localStorage.setItem(
    APP_SETTINGS_STORAGE_KEY,
    JSON.stringify({ enableAssistantStreaming: false }),
  );
  api.migrateClientSetting.mockResolvedValueOnce({ applied: true, currentValue: false });
  await migrateLegacyClientSetting();
  expect(api.migrateClientSetting).toHaveBeenCalledWith({
    key: "enableAssistantStreaming",
    value: false,
  });
  expect(JSON.parse(localStorage.getItem(APP_SETTINGS_STORAGE_KEY)!)).toEqual({});
});
