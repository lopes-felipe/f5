import { DEFAULT_THREAD_TITLE_MODEL_BY_PROVIDER } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  CLAUDE_SUBAGENT_MODEL_INHERIT,
  DEFAULT_TIMESTAMP_FORMAT,
  DISPLAY_PROFILE_KEYS,
  DISPLAY_PROFILE_NAMES,
  DISPLAY_PROFILE_PRESETS,
  displayProfilePatchFor,
  getDisplayProfile,
  getClaudeProjectSettings,
  getAppModelOptions,
  getSlashModelOptions,
  normalizeCustomModelSlugs,
  parsePersistedAppSettings,
  type AppSettings,
  type DisplayProfileKey,
  resolveAuxiliaryAppModelSelection,
  resolveAppModelSelection,
  resolveThreadTitleModel,
} from "./appSettings";

const _displayProfileKeyTypecheck: Pick<AppSettings, DisplayProfileKey> =
  parsePersistedAppSettings(null);
void _displayProfileKeyTypecheck;

function toggledProfileValue(
  settings: AppSettings,
  key: DisplayProfileKey,
): AppSettings[DisplayProfileKey] {
  if (key === "runtimeWarningVisibility") {
    return settings.runtimeWarningVisibility === "hidden" ? "full" : "hidden";
  }
  return !settings[key];
}

describe("parsePersistedAppSettings", () => {
  it("defaults git status auto-refresh to true", () => {
    expect(parsePersistedAppSettings(null).enableGitStatusAutoRefresh).toBe(true);
  });

  it("defaults thread status notifications to true", () => {
    expect(parsePersistedAppSettings(null).enableThreadStatusNotifications).toBe(true);
  });

  it("defaults assistant streaming to true", () => {
    expect(parsePersistedAppSettings(null).enableAssistantStreaming).toBe(true);
  });

  it("defaults workflow threads to collapsed in the sidebar", () => {
    expect(parsePersistedAppSettings(null).expandWorkflowThreadsByDefault).toBe(false);
  });

  it("defaults agent command transcripts to true", () => {
    expect(parsePersistedAppSettings(null).showAgentCommandTranscripts).toBe(true);
  });

  it("defaults always-expanded command transcripts to false", () => {
    expect(parsePersistedAppSettings(null).alwaysExpandAgentCommandTranscripts).toBe(false);
  });

  it("defaults MCP tool call expansion to true", () => {
    expect(parsePersistedAppSettings(null).expandMcpToolCalls).toBe(true);
  });

  it("defaults MCP tool call cards to collapsed", () => {
    expect(parsePersistedAppSettings(null).expandMcpToolCallCardsByDefault).toBe(false);
  });

  it("defaults reasoning expansion to false", () => {
    expect(parsePersistedAppSettings(null).showReasoningExpanded).toBe(false);
  });

  it("defaults inline file-change diffs to on", () => {
    expect(parsePersistedAppSettings(null).showFileChangeDiffsInline).toBe(true);
  });

  it("defaults runtime warning visibility to summarized", () => {
    expect(parsePersistedAppSettings(null).runtimeWarningVisibility).toBe("summarized");
  });

  it("defaults provider runtime metadata visibility to false", () => {
    expect(parsePersistedAppSettings(null).showProviderRuntimeMetadata).toBe(false);
  });

  it("defaults onboarding lite status to eligible", () => {
    expect(parsePersistedAppSettings(null).onboardingLiteStatus).toBe("eligible");
  });

  it("defaults file-link panel navigation to true", () => {
    expect(parsePersistedAppSettings(null).openFileLinksInPanel).toBe(true);
  });

  it("defaults task sidebar auto-open to true", () => {
    expect(parsePersistedAppSettings(null).tasksPanelAutoOpen).toBe(true);
  });

  it("defaults Claude project subagent settings to enabled + inherit", () => {
    const parsed = parsePersistedAppSettings(null);
    expect(getClaudeProjectSettings(parsed, "project-1")).toEqual({
      subagentsEnabled: true,
      subagentModel: CLAUDE_SUBAGENT_MODEL_INHERIT,
    });
  });

  it("decodes older persisted settings payloads with git status auto-refresh enabled", () => {
    const parsed = parsePersistedAppSettings(
      JSON.stringify({
        codexBinaryPath: "",
        codexHomePath: "",
        confirmThreadDelete: true,
        enableAssistantStreaming: false,
        customCodexModels: [],
      }),
    );

    expect(parsed.enableGitStatusAutoRefresh).toBe(true);
    expect(parsed.enableThreadStatusNotifications).toBe(true);
    expect(parsed.expandWorkflowThreadsByDefault).toBe(false);
    expect(parsed.showAgentCommandTranscripts).toBe(true);
    expect(parsed.alwaysExpandAgentCommandTranscripts).toBe(false);
    expect(parsed.expandMcpToolCalls).toBe(true);
    expect(parsed.expandMcpToolCallCardsByDefault).toBe(false);
    expect(parsed.showReasoningExpanded).toBe(false);
    expect(parsed.showFileChangeDiffsInline).toBe(true);
    expect(parsed.runtimeWarningVisibility).toBe("summarized");
    expect(parsed.showProviderRuntimeMetadata).toBe(false);
    expect(parsed.onboardingLiteStatus).toBe("eligible");
    expect(parsed.openFileLinksInPanel).toBe(true);
    expect(parsed.tasksPanelAutoOpen).toBe(true);
    expect(parsed.codexThreadTitleModel).toBe(DEFAULT_THREAD_TITLE_MODEL_BY_PROVIDER.codex);
  });

  it("falls back to eligible when persisted onboarding lite status is invalid", () => {
    const parsed = parsePersistedAppSettings(
      JSON.stringify({
        onboardingLiteStatus: "later",
      }),
    );

    expect(parsed.onboardingLiteStatus).toBe("eligible");
  });

  it("preserves the explicit reopened onboarding lite status", () => {
    const parsed = parsePersistedAppSettings(
      JSON.stringify({
        onboardingLiteStatus: "reopened",
      }),
    );

    expect(parsed.onboardingLiteStatus).toBe("reopened");
  });

  it("restores an explicit persisted file-link panel preference", () => {
    const parsed = parsePersistedAppSettings(
      JSON.stringify({
        openFileLinksInPanel: false,
      }),
    );

    expect(parsed.openFileLinksInPanel).toBe(false);
  });

  it("restores a persisted inline file-change diff preference", () => {
    const parsed = parsePersistedAppSettings(
      JSON.stringify({
        showFileChangeDiffsInline: true,
      }),
    );

    expect(parsed.showFileChangeDiffsInline).toBe(true);
  });

  it("restores a persisted thread title model selection", () => {
    const parsed = parsePersistedAppSettings(
      JSON.stringify({
        codexBinaryPath: "",
        codexHomePath: "",
        defaultThreadEnvMode: "local",
        expandWorkflowThreadsByDefault: true,
        confirmThreadDelete: true,
        enableAssistantStreaming: false,
        enableGitStatusAutoRefresh: true,
        enableThreadStatusNotifications: true,
        showAgentCommandTranscripts: false,
        alwaysExpandAgentCommandTranscripts: false,
        expandMcpToolCalls: false,
        expandMcpToolCallCardsByDefault: false,
        showReasoningExpanded: true,
        runtimeWarningVisibility: "full",
        showProviderRuntimeMetadata: false,
        timestampFormat: DEFAULT_TIMESTAMP_FORMAT,
        customCodexModels: ["custom/thread-title-model"],
        customClaudeModels: [],
        codexThreadTitleModel: "custom/thread-title-model",
      }),
    );

    expect(parsed.codexThreadTitleModel).toBe("custom/thread-title-model");
    expect(parsed.expandWorkflowThreadsByDefault).toBe(true);
    expect(parsed.expandMcpToolCallCardsByDefault).toBe(false);
    expect(parsed.showReasoningExpanded).toBe(true);
    expect(parsed.runtimeWarningVisibility).toBe("full");
  });

  it("migrates the legacy Claude runtime metadata key", () => {
    const parsed = parsePersistedAppSettings(
      JSON.stringify({
        showClaudeRuntimeMetadata: true,
      }),
    );

    expect(parsed.showProviderRuntimeMetadata).toBe(true);
  });

  it("restores persisted Claude project subagent settings", () => {
    const parsed = parsePersistedAppSettings(
      JSON.stringify({
        claudeProjectSettings: {
          "project-1": {
            subagentsEnabled: false,
            subagentModel: "claude-haiku-4-5",
          },
        },
      }),
    );

    expect(getClaudeProjectSettings(parsed, "project-1")).toEqual({
      subagentsEnabled: false,
      subagentModel: "claude-haiku-4-5",
    });
  });

  it("restores persisted runtime warning visibility values", () => {
    expect(
      parsePersistedAppSettings(
        JSON.stringify({
          runtimeWarningVisibility: "hidden",
        }),
      ).runtimeWarningVisibility,
    ).toBe("hidden");

    expect(
      parsePersistedAppSettings(
        JSON.stringify({
          runtimeWarningVisibility: "summarized",
        }),
      ).runtimeWarningVisibility,
    ).toBe("summarized");

    expect(
      parsePersistedAppSettings(
        JSON.stringify({
          runtimeWarningVisibility: "full",
        }),
      ).runtimeWarningVisibility,
    ).toBe("full");
  });

  it("falls back to summarized when the persisted runtime warning visibility is invalid", () => {
    const parsed = parsePersistedAppSettings(
      JSON.stringify({
        runtimeWarningVisibility: "verbose",
        showReasoningExpanded: true,
      }),
    );

    expect(parsed.runtimeWarningVisibility).toBe("summarized");
    expect(parsed.showReasoningExpanded).toBe(true);
  });
});
describe("normalizeCustomModelSlugs", () => {
  it("normalizes aliases, removes built-ins, and deduplicates values", () => {
    expect(
      normalizeCustomModelSlugs([
        " custom/internal-model ",
        "gpt-5.3-codex",
        "5.3",
        "custom/internal-model",
        "",
        null,
      ]),
    ).toEqual(["custom/internal-model"]);
  });

  it("removes built-in Claude aliases and slugs from saved custom models", () => {
    expect(
      normalizeCustomModelSlugs(
        ["opus", "claude-opus-4-7", "claude-opus-4-6", "custom/claude-model"],
        "claudeAgent",
      ),
    ).toEqual(["custom/claude-model"]);
  });
});

describe("displayProfile", () => {
  it.each(DISPLAY_PROFILE_KEYS)("keeps the balanced preset aligned with defaults for %s", (key) => {
    expect(DISPLAY_PROFILE_PRESETS.balanced[key]).toBe(parsePersistedAppSettings(null)[key]);
  });

  it("derives the default settings as balanced", () => {
    expect(getDisplayProfile(parsePersistedAppSettings(null))).toBe("balanced");
  });

  it.each(DISPLAY_PROFILE_NAMES)("detects the %s preset", (name) => {
    expect(getDisplayProfile({ ...DISPLAY_PROFILE_PRESETS[name] })).toBe(name);
  });

  it.each(
    DISPLAY_PROFILE_NAMES.flatMap((name) =>
      DISPLAY_PROFILE_KEYS.map((key) => [name, key] as const),
    ),
  )("returns custom when %s deviates on %s", (name, key) => {
    const preset = DISPLAY_PROFILE_PRESETS[name];
    const candidate = {
      ...preset,
      [key]: toggledProfileValue(preset as AppSettings, key),
    };

    const expectedProfile =
      name === "minimal" &&
      ((key === "alwaysExpandAgentCommandTranscripts" &&
        preset.showAgentCommandTranscripts === false) ||
        (key === "expandMcpToolCallCardsByDefault" && preset.expandMcpToolCalls === false))
        ? "minimal"
        : "custom";

    expect(getDisplayProfile(candidate)).toBe(expectedProfile);
  });

  it("canonicalizes latent transcript and MCP child flags before comparing presets", () => {
    expect(
      getDisplayProfile({
        ...DISPLAY_PROFILE_PRESETS.minimal,
        alwaysExpandAgentCommandTranscripts: true,
      }),
    ).toBe("minimal");

    expect(
      getDisplayProfile({
        ...DISPLAY_PROFILE_PRESETS.minimal,
        expandMcpToolCallCardsByDefault: true,
      }),
    ).toBe("minimal");
  });

  it("returns only the governed keys when building a preset patch", () => {
    expect(Object.keys(displayProfilePatchFor("detailed")).toSorted()).toEqual(
      [...DISPLAY_PROFILE_KEYS].toSorted(),
    );
  });

  it("round-trips to minimal after applying the minimal patch to a detailed state", () => {
    const candidate = {
      ...DISPLAY_PROFILE_PRESETS.detailed,
      ...displayProfilePatchFor("minimal"),
    };

    expect(getDisplayProfile(candidate)).toBe("minimal");
  });

  it.each(DISPLAY_PROFILE_NAMES)("ignores non-governed keys when deriving %s", (name) => {
    const candidate = {
      ...DISPLAY_PROFILE_PRESETS[name],
      enableAssistantStreaming: !parsePersistedAppSettings(null).enableAssistantStreaming,
      openFileLinksInPanel: !parsePersistedAppSettings(null).openFileLinksInPanel,
    };

    expect(getDisplayProfile(candidate)).toBe(name);
  });

  it("treats persisted mixed states as custom without mutating them", () => {
    const persisted = JSON.stringify({
      ...DISPLAY_PROFILE_PRESETS.balanced,
      showAgentCommandTranscripts: false,
      alwaysExpandAgentCommandTranscripts: true,
      showProviderRuntimeMetadata: true,
    });

    expect(getDisplayProfile(parsePersistedAppSettings(persisted))).toBe("custom");
    expect(JSON.parse(persisted)).toMatchObject({
      showAgentCommandTranscripts: false,
      alwaysExpandAgentCommandTranscripts: true,
      showProviderRuntimeMetadata: true,
    });
  });

  it("lands on a named preset when manual edits exactly match it", () => {
    const candidate = {
      ...DISPLAY_PROFILE_PRESETS.detailed,
      ...DISPLAY_PROFILE_PRESETS.balanced,
    };

    expect(getDisplayProfile(candidate)).toBe("balanced");
  });

  it("keeps the owned key list unique", () => {
    expect(DISPLAY_PROFILE_KEYS).toHaveLength(new Set(DISPLAY_PROFILE_KEYS).size);
  });
});

describe("getAppModelOptions", () => {
  it("appends saved custom models after the built-in options", () => {
    const options = getAppModelOptions("codex", ["custom/internal-model"]);

    expect(options.map((option) => option.slug)).toEqual([
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
      "gpt-5.2-codex",
      "gpt-5.2",
      "custom/internal-model",
    ]);
  });

  it("keeps the currently selected custom model available even if it is no longer saved", () => {
    const options = getAppModelOptions("codex", [], "custom/selected-model");

    expect(options.at(-1)).toEqual({
      slug: "custom/selected-model",
      name: "custom/selected-model",
      isCustom: true,
    });
  });

  it("lists Claude Opus models before Sonnet and Haiku in built-in Claude options", () => {
    const options = getAppModelOptions("claudeAgent", []);

    expect(options.slice(0, 5).map((option) => option.slug)).toEqual([
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-opus-4-5",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ]);
  });
});

describe("resolveAppModelSelection", () => {
  it("preserves saved custom model slugs instead of falling back to the default", () => {
    expect(resolveAppModelSelection("codex", ["galapagos-alpha"], "galapagos-alpha")).toBe(
      "galapagos-alpha",
    );
  });

  it("falls back to the provider default when no model is selected", () => {
    expect(resolveAppModelSelection("codex", [], "")).toBe("gpt-5.5");
  });
});

describe("resolveAuxiliaryAppModelSelection", () => {
  it("preserves saved auxiliary custom model slugs", () => {
    expect(
      resolveAuxiliaryAppModelSelection(
        "codex",
        ["galapagos-alpha"],
        "galapagos-alpha",
        DEFAULT_THREAD_TITLE_MODEL_BY_PROVIDER.codex,
      ),
    ).toBe("galapagos-alpha");
  });

  it("falls back to the auxiliary default when the selection is empty", () => {
    expect(
      resolveAuxiliaryAppModelSelection(
        "codex",
        [],
        "",
        DEFAULT_THREAD_TITLE_MODEL_BY_PROVIDER.codex,
      ),
    ).toBe(DEFAULT_THREAD_TITLE_MODEL_BY_PROVIDER.codex);
  });

  it("falls back to the auxiliary default when a custom model slug was removed", () => {
    expect(
      resolveAuxiliaryAppModelSelection(
        "codex",
        [],
        "removed-custom-model",
        DEFAULT_THREAD_TITLE_MODEL_BY_PROVIDER.codex,
      ),
    ).toBe(DEFAULT_THREAD_TITLE_MODEL_BY_PROVIDER.codex);
  });

  it("matches built-in model names case-insensitively", () => {
    expect(
      resolveAuxiliaryAppModelSelection(
        "codex",
        [],
        "gpt-5.3 codex",
        DEFAULT_THREAD_TITLE_MODEL_BY_PROVIDER.codex,
      ),
    ).toBe("gpt-5.3-codex");
  });
});

describe("resolveThreadTitleModel", () => {
  it("resolves the saved codex thread title model", () => {
    expect(
      resolveThreadTitleModel({
        customCodexModels: ["galapagos-alpha"],
        codexThreadTitleModel: "galapagos-alpha",
      }),
    ).toBe("galapagos-alpha");
  });

  it("falls back to the default codex thread title model", () => {
    expect(
      resolveThreadTitleModel({
        customCodexModels: [],
        codexThreadTitleModel: "",
      }),
    ).toBe(DEFAULT_THREAD_TITLE_MODEL_BY_PROVIDER.codex);
  });
});

describe("getSlashModelOptions", () => {
  it("includes saved custom model slugs for /model command suggestions", () => {
    const options = getSlashModelOptions("codex", ["custom/internal-model"], "", "gpt-5.3-codex");

    expect(options.some((option) => option.slug === "custom/internal-model")).toBe(true);
  });

  it("filters slash-model suggestions across built-in and custom model names", () => {
    const options = getSlashModelOptions("codex", ["openai/gpt-oss-120b"], "oss", "gpt-5.3-codex");

    expect(options.map((option) => option.slug)).toEqual(["openai/gpt-oss-120b"]);
  });
});

describe("timestamp format defaults", () => {
  it("defaults timestamp format to locale", () => {
    expect(DEFAULT_TIMESTAMP_FORMAT).toBe("locale");
  });
});
