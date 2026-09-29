import { afterEach, expect, it, vi } from "vitest";
import { APP_SETTINGS_STORAGE_KEY } from "../appSettings";
import { migrateLegacyClientSetting, readLegacyClientSetting } from "./useMigrateClientSettings";
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
