import legacySettings from "./fixtures/server-settings-290d261c9.json";
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { DEFAULT_SERVER_SETTINGS, ProjectId, ServerSettings } from "@t3tools/contracts";
import { resolveProjectSettings } from "./projectSettings";
import { applyServerSettingsPatch } from "./serverSettings";
const id = ProjectId.makeUnsafe("project-test");
describe("project settings", () => {
  it("resolves override, legacy, file, global and built-in defaults in order", () => {
    const global = { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: "worktree" as const };
    expect(resolveProjectSettings({ projectId: id }).sources.defaultThreadEnvMode).toBe("default");
    expect(resolveProjectSettings({ projectId: id, global }).settings.defaultThreadEnvMode).toBe(
      "worktree",
    );
    const input = {
      global,
      projectId: id,
      checkedIn: { defaultThreadEnvMode: "local" as const },
      sourceFile: "t3.json" as const,
    };
    expect(resolveProjectSettings(input).sources.defaultThreadEnvMode).toBe("t3.json");
    expect(
      resolveProjectSettings({ ...input, legacyEnvMode: "worktree" }).settings.defaultThreadEnvMode,
    ).toBe("worktree");
    const scoped = applyServerSettingsPatch(global, {
      projectSettingsOverrides: {
        [id]: {
          defaultThreadEnvMode: "local",
          enableAssistantStreaming: false,
          prHubDefaultMergeMethod: null,
        },
      },
    });
    const result = resolveProjectSettings({ ...input, global: scoped, legacyEnvMode: "worktree" });
    expect(result.settings.defaultThreadEnvMode).toBe("local");
    expect(result.sources.defaultThreadEnvMode).toBe("project");
    expect(result.settings.prHubDefaultMergeMethod).toBeNull();
    expect(result.settings.enableAssistantStreaming).toBe(false);
    expect(result.sources.defaultRuntimeMode).toBe("global");
  });
  it("replaces one project entry and resets without altering other projects", () => {
    const other = ProjectId.makeUnsafe("other");
    const initial = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectSettingsOverrides: {
        [id]: { worktreeSubmodules: "none", defaultRuntimeMode: "approval-required" },
        [other]: { enableAssistantStreaming: true },
      },
    });
    const next = applyServerSettingsPatch(initial, {
      projectSettingsOverrides: { [id]: { defaultRuntimeMode: "full-access" } },
    });
    expect(next.projectSettingsOverrides[id]).toEqual({ defaultRuntimeMode: "full-access" });
    const reset = applyServerSettingsPatch(next, { projectSettingsOverrides: { [id]: null } });
    expect(reset.projectSettingsOverrides).toEqual({ [other]: { enableAssistantStreaming: true } });
  });
  it("decodes a synthetic settings document using the 290d261c9 schema", () => {
    const decoded = Schema.decodeUnknownSync(ServerSettings)(legacySettings);
    expect(decoded).toMatchObject({
      gitAuthorName: "Legacy User",
      defaultThreadEnvMode: "worktree",
      defaultRuntimeMode: "full-access",
      worktreeSubmodules: "recursive",
      projectSettingsOverrides: {},
      clientSettingMigrations: {},
      sourceControlWriting: legacySettings.sourceControlWriting,
      textGenerationModelSelection: legacySettings.textGenerationModelSelection,
    });
  });
});
