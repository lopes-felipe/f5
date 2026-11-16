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
  it.each(["codex", undefined] as const)(
    "preserves non-effort options for every remembered provider (last provider %s)",
    (lastProvider) => {
      const result = resolveNewThreadPreferences(undefined, DEFAULT_SERVER_SETTINGS, {
        lastProvider: lastProvider ?? null,
        lastModelByProvider: {},
        lastModelOptions: {
          codex: { reasoningEffort: "medium", fastMode: true },
          claudeAgent: { effort: "low", thinking: false, fastMode: true, contextWindow: "1m" },
          cursor: { reasoning: "medium", thinking: false, contextWindow: "200k" },
          opencode: { variant: "high", agent: "build" },
          pi: { thinking: "minimal" },
        },
      });
      expect(result.options).toEqual({
        codex: { fastMode: true },
        claudeAgent: { thinking: false, fastMode: true, contextWindow: "1m" },
        cursor: { thinking: false, contextWindow: "200k" },
        opencode: { agent: "build" },
      });
    },
  );
  it("identifies remembered provider choices even without remembered options", () => {
    expect(
      resolveNewThreadPreferences(undefined, DEFAULT_SERVER_SETTINGS, {
        lastProvider: "codex",
        lastModelByProvider: { codex: "gpt-5" },
        lastModelOptions: null,
      }).source,
    ).toBe("remembered");
  });
  it("preserves explicit project Medium while dropping remembered effort only", () => {
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      providers: { codex: { enabled: true } },
    });
    const result = resolveNewThreadPreferences(
      {
        id: projectId,
        defaultModelSelection: createModelSelection(codex, "gpt-5", [
          { id: "reasoningEffort", value: "medium" },
        ]),
      },
      settings,
      preferences,
    );
    expect(result.source).toBe("project");
    expect(result.options?.codex?.reasoningEffort).toBe("medium");
  });
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
      source: "fallback",
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
      options: null,
      source: "remembered",
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
      source: "project",
    });
  });
});
