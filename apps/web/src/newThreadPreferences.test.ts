import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { createModelSelection } from "@t3tools/shared/model";
import { resolveNewThreadPreferences } from "./newThreadPreferences";

const projectId = ProjectId.makeUnsafe("project");
const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");
const preferences = {
  lastProvider: "claudeAgent" as const,
  lastModelByProvider: { claudeAgent: "claude-opus-5-5" },
  lastModelOptions: { claudeAgent: { effort: "high" as const } },
};

describe("shared new-thread and scheduled-task defaults", () => {
  it("honors project instance disablement before remembered provider choices", () => {
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      providers: { claudeAgent: { enabled: true }, codex: { enabled: true } },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [claude]: { enabled: false } } },
      },
    });
    expect(resolveNewThreadPreferences({ id: projectId }, settings, preferences)).toEqual({
      provider: "codex",
      instanceId: codex,
      model: DEFAULT_MODEL_BY_PROVIDER.codex,
      options: null,
    });
  });

  it("falls back from a disabled project default without copying its model options", () => {
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      providers: { claudeAgent: { enabled: true }, codex: { enabled: true } },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [codex]: { enabled: false } } },
      },
    });
    expect(
      resolveNewThreadPreferences(
        { id: projectId, defaultModelSelection: createModelSelection(codex, "gpt-5") },
        settings,
        preferences,
      ),
    ).toEqual({
      provider: "claudeAgent",
      model: "claude-opus-5-5",
      options: preferences.lastModelOptions,
    });
  });

  it("honors project re-enablement of an otherwise disabled default instance", () => {
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      providers: { codex: { enabled: false } },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [codex]: { enabled: true } } },
      },
    });
    expect(
      resolveNewThreadPreferences(
        { id: projectId, defaultModelSelection: createModelSelection(codex, "gpt-5") },
        settings,
        preferences,
      ),
    ).toEqual({
      provider: "codex",
      instanceId: codex,
      model: "gpt-5",
      options: null,
    });
  });
});
