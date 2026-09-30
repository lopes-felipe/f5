import { describe, expect, it } from "vitest";
import { DEFAULT_SERVER_SETTINGS, ProjectId } from "@t3tools/contracts";
import { resolveCachedProjectThreadEnvMode } from "./projectConfigReactQuery";
import { rememberDraftSettings, defaultDraftRuntimeMode } from "./draftSettingsDefaults";
const id = ProjectId.makeUnsafe("cached-project");
describe("cached draft defaults", () => {
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
});
