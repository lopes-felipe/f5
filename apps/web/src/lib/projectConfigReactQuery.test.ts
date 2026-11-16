import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  DEFAULT_SERVER_SETTINGS,
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  ProjectId,
  type ProjectSettingsResult,
} from "@t3tools/contracts";
import {
  cachedProjectThreadEnvModeSource,
  resolveCachedProjectThreadEnvMode,
  resolveProjectThreadEnvMode,
} from "./projectConfigReactQuery";
import { rememberDraftSettings, defaultDraftRuntimeMode } from "./draftSettingsDefaults";
import { noteWsConnectionOpened, resetWsConnectionStateForTests } from "../wsConnectionState";
import { projectSettingsQueryOptions } from "./projectSettingsQuery";
const id = ProjectId.makeUnsafe("cached-project");
const settingsApi = vi.hoisted(() => ({ getProjectSettings: vi.fn() }));
vi.mock("../nativeApi", () => ({ ensureNativeApi: () => ({ server: settingsApi }) }));
afterEach(() => {
  vi.restoreAllMocks();
  settingsApi.getProjectSettings.mockReset();
  resetWsConnectionStateForTests();
  rememberDraftSettings(DEFAULT_SERVER_SETTINGS);
});
describe("cached draft defaults", () => {
  it("fetches server settings over a stale cache when connected", async () => {
    noteWsConnectionOpened();
    const queryClient = new QueryClient();
    const query = projectSettingsQueryOptions(id);
    queryClient.setQueryData(
      query.queryKey,
      resolveProjectSettings({
        projectId: id,
        global: { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: "local" },
      }),
      { updatedAt: 0 },
    );
    const serverResult = resolveProjectSettings({
      projectId: id,
      global: { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: "worktree" },
    });
    settingsApi.getProjectSettings.mockResolvedValue(serverResult);
    const fetch = vi.spyOn(queryClient, "fetchQuery");

    await expect(resolveProjectThreadEnvMode(queryClient, id)).resolves.toBe("worktree");

    expect(settingsApi.getProjectSettings).toHaveBeenCalledExactlyOnceWith({ projectId: id });
    expect(fetch).toHaveBeenCalledOnce();
    expect(queryClient.getQueryData(query.queryKey)).toEqual(serverResult);
    queryClient.clear();
  });

  it("uses cached resolved settings offline without starting a query", async () => {
    resetWsConnectionStateForTests();
    const queryClient = new QueryClient();
    queryClient.setQueryData(projectSettingsQueryOptions(id).queryKey, {
      overrides: {},
      settings: { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: "worktree" },
      sources: Object.fromEntries(
        PROJECT_SCOPED_SERVER_SETTING_KEYS.map((key) => [key, "t3.json"]),
      ) as ProjectSettingsResult["sources"],
    });
    const fetch = vi.spyOn(queryClient, "fetchQuery");
    await expect(resolveProjectThreadEnvMode(queryClient, id)).resolves.toBe("worktree");
    await expect(
      resolveProjectThreadEnvMode(queryClient, id, { forceNonDefault: true }),
    ).resolves.toBe("local");
    await expect(
      resolveProjectThreadEnvMode(queryClient, id, { requested: "local" }),
    ).resolves.toBe("local");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the global default offline when no project settings are cached", async () => {
    resetWsConnectionStateForTests();
    rememberDraftSettings(DEFAULT_SERVER_SETTINGS);
    await expect(resolveProjectThreadEnvMode(new QueryClient(), id)).resolves.toBe(
      DEFAULT_SERVER_SETTINGS.defaultThreadEnvMode,
    );
  });

  it("keeps resolved project permissions across unrelated global updates", () => {
    rememberDraftSettings(
      { ...DEFAULT_SERVER_SETTINGS, defaultRuntimeMode: "approval-required" },
      id,
    );
    rememberDraftSettings(DEFAULT_SERVER_SETTINGS);
    expect(defaultDraftRuntimeMode(id)).toBe("approval-required");
    expect(defaultDraftRuntimeMode(ProjectId.makeUnsafe("never-loaded"))).toBe("approval-required");
  });
  it("uses a saved project workspace override when the server is unavailable", () => {
    rememberDraftSettings({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: { [id]: { defaultThreadEnvMode: "worktree" } },
    });
    expect(resolveCachedProjectThreadEnvMode(id)).toBe("worktree");
    rememberDraftSettings(DEFAULT_SERVER_SETTINGS);
    expect(resolveCachedProjectThreadEnvMode(id)).toBe("local");
  });
  it("reports an unknown workspace source unless the checked-in config is cached", () => {
    rememberDraftSettings(DEFAULT_SERVER_SETTINGS);
    const checkedIn = {
      projectId: id,
      sourceFile: "f5.json" as const,
      defaultThreadEnvMode: null,
      iconPath: null,
      upstream: null,
      diagnostics: [],
    };
    expect(cachedProjectThreadEnvModeSource(id, undefined)).toBeNull();
    expect(cachedProjectThreadEnvModeSource(id, checkedIn)).toBe("global");
    expect(
      cachedProjectThreadEnvModeSource(id, { ...checkedIn, defaultThreadEnvMode: "local" }),
    ).toBe("f5.json");
    expect(
      cachedProjectThreadEnvModeSource(id, {
        ...checkedIn,
        sourceFile: "t3.json",
        settings: { defaultThreadEnvMode: "local" },
      }),
    ).toBe("t3.json");
    rememberDraftSettings({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: { [id]: { defaultThreadEnvMode: "worktree" } },
    });
    expect(cachedProjectThreadEnvModeSource(id, undefined)).toBe("project");
    rememberDraftSettings(DEFAULT_SERVER_SETTINGS);
  });
});
