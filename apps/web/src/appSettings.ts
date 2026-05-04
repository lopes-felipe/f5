import { useCallback } from "react";
import { Option, Schema } from "effect";
import {
  DEFAULT_THREAD_TITLE_MODEL_BY_PROVIDER,
  TrimmedNonEmptyString,
  type ProviderKind,
} from "@t3tools/contracts";
import { getDefaultModel, getModelOptions, normalizeModelSlug } from "@t3tools/shared/model";
import { useLocalStorage } from "./hooks/useLocalStorage";

const APP_SETTINGS_STORAGE_KEY = "t3code:app-settings:v1";
const MAX_CUSTOM_MODEL_COUNT = 32;
export const MAX_CUSTOM_MODEL_LENGTH = 256;
export const CLAUDE_SUBAGENT_MODEL_INHERIT = "inherit";
export const TIMESTAMP_FORMAT_OPTIONS = ["locale", "12-hour", "24-hour"] as const;
export type TimestampFormat = (typeof TIMESTAMP_FORMAT_OPTIONS)[number];
export const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = "locale";
export const RUNTIME_WARNING_VISIBILITY_OPTIONS = ["hidden", "summarized", "full"] as const;
export type RuntimeWarningVisibility = (typeof RUNTIME_WARNING_VISIBILITY_OPTIONS)[number];
export const ONBOARDING_LITE_STATUS_OPTIONS = [
  "eligible",
  "dismissed",
  "completed",
  "reopened",
] as const;
export type OnboardingLiteStatus = (typeof ONBOARDING_LITE_STATUS_OPTIONS)[number];

// Excluded intentionally: keys whose preset value stays the same across every
// named profile should not force the UI into Custom when toggled.
export const DISPLAY_PROFILE_KEYS = [
  "expandWorkflowThreadsByDefault",
  "showAgentCommandTranscripts",
  "alwaysExpandAgentCommandTranscripts",
  "expandMcpToolCalls",
  "expandMcpToolCallCardsByDefault",
  "showFileChangeDiffsInline",
  "showReasoningExpanded",
  "runtimeWarningVisibility",
  "showProviderRuntimeMetadata",
] as const;
export type DisplayProfileKey = (typeof DISPLAY_PROFILE_KEYS)[number];
export const DISPLAY_PROFILE_NAMES = ["minimal", "balanced", "detailed"] as const;
export type DisplayProfileName = (typeof DISPLAY_PROFILE_NAMES)[number];
export type DisplayProfile = DisplayProfileName | "custom";
export const DISPLAY_PROFILE_LABELS: Record<DisplayProfileName, string> = {
  minimal: "Minimal",
  balanced: "Balanced",
  detailed: "Detailed",
};
export const DISPLAY_PROFILE_DESCRIPTIONS: Record<DisplayProfile, string> = {
  minimal: "Condense the chat view to the least amount of inline detail.",
  balanced: "Keep a balance between compact logs and useful detail.",
  detailed: "Show the fullest inline view of transcripts, diffs, warnings, and metadata.",
  custom: "A manual mix of display settings.",
};
export const DISPLAY_PROFILE_CUSTOM_WARNING =
  "Selecting a preset will overwrite your custom display settings.";
const DEFAULT_SHOW_REASONING_EXPANDED = false;
const DEFAULT_RUNTIME_WARNING_VISIBILITY: RuntimeWarningVisibility = "summarized";
const BUILT_IN_MODEL_SLUGS_BY_PROVIDER: Record<ProviderKind, ReadonlySet<string>> = {
  codex: new Set(getModelOptions("codex").map((option) => option.slug)),
  claudeAgent: new Set(getModelOptions("claudeAgent").map((option) => option.slug)),
};

type PersistedAppSettingsValue = Record<string, unknown> & {
  readonly showClaudeRuntimeMetadata?: boolean;
  readonly showProviderRuntimeMetadata?: boolean;
  readonly onboardingLiteStatus?: unknown;
};

const ClaudeProjectSettingsSchema = Schema.Struct({
  subagentsEnabled: Schema.Boolean.pipe(Schema.withConstructorDefault(() => Option.some(true))),
  subagentModel: Schema.String.check(Schema.isMaxLength(MAX_CUSTOM_MODEL_LENGTH)).pipe(
    Schema.withConstructorDefault(() => Option.some(CLAUDE_SUBAGENT_MODEL_INHERIT)),
  ),
});
export type ClaudeProjectSettings = typeof ClaudeProjectSettingsSchema.Type;

function normalizeRuntimeWarningVisibility(value: unknown): RuntimeWarningVisibility {
  if (value === "hidden" || value === "summarized" || value === "full") {
    return value;
  }
  return DEFAULT_RUNTIME_WARNING_VISIBILITY;
}

function normalizeOnboardingLiteStatus(value: unknown): OnboardingLiteStatus {
  if (
    value === "eligible" ||
    value === "dismissed" ||
    value === "completed" ||
    value === "reopened"
  ) {
    return value;
  }
  return "eligible";
}

const AppSettingsSchema = Schema.Struct({
  codexBinaryPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  codexHomePath: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  claudeBinaryPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  defaultThreadEnvMode: Schema.Literals(["local", "worktree"]).pipe(
    Schema.withConstructorDefault(() => Option.some("local")),
  ),
  tasksPanelAutoOpen: Schema.Boolean.pipe(Schema.withConstructorDefault(() => Option.some(true))),
  expandWorkflowThreadsByDefault: Schema.Boolean.pipe(
    Schema.withConstructorDefault(() => Option.some(false)),
  ),
  confirmThreadDelete: Schema.Boolean.pipe(Schema.withConstructorDefault(() => Option.some(true))),
  enableAssistantStreaming: Schema.Boolean.pipe(
    Schema.withConstructorDefault(() => Option.some(true)),
  ),
  enableGitStatusAutoRefresh: Schema.Boolean.pipe(
    Schema.withConstructorDefault(() => Option.some(true)),
  ),
  enableThreadStatusNotifications: Schema.Boolean.pipe(
    Schema.withConstructorDefault(() => Option.some(true)),
  ),
  showAgentCommandTranscripts: Schema.Boolean.pipe(
    Schema.withConstructorDefault(() => Option.some(true)),
  ),
  alwaysExpandAgentCommandTranscripts: Schema.Boolean.pipe(
    Schema.withConstructorDefault(() => Option.some(false)),
  ),
  expandMcpToolCalls: Schema.Boolean.pipe(Schema.withConstructorDefault(() => Option.some(true))),
  expandMcpToolCallCardsByDefault: Schema.Boolean.pipe(
    Schema.withConstructorDefault(() => Option.some(false)),
  ),
  showFileChangeDiffsInline: Schema.Boolean.pipe(
    Schema.withConstructorDefault(() => Option.some(true)),
  ),
  showReasoningExpanded: Schema.Boolean.pipe(
    Schema.withConstructorDefault(() => Option.some(DEFAULT_SHOW_REASONING_EXPANDED)),
  ),
  runtimeWarningVisibility: Schema.Literals(["hidden", "summarized", "full"]).pipe(
    Schema.withConstructorDefault(() => Option.some(DEFAULT_RUNTIME_WARNING_VISIBILITY)),
  ),
  showProviderRuntimeMetadata: Schema.Boolean.pipe(
    Schema.withConstructorDefault(() => Option.some(false)),
  ),
  onboardingLiteStatus: Schema.Literals(["eligible", "dismissed", "completed", "reopened"]).pipe(
    Schema.withConstructorDefault(() => Option.some("eligible" as const)),
    Schema.withDecodingDefault(() => "eligible" as const),
  ),
  openFileLinksInPanel: Schema.Boolean.pipe(Schema.withConstructorDefault(() => Option.some(true))),
  timestampFormat: Schema.Literals(["locale", "12-hour", "24-hour"]).pipe(
    Schema.withConstructorDefault(() => Option.some(DEFAULT_TIMESTAMP_FORMAT)),
  ),
  customCodexModels: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(() => Option.some([])),
  ),
  customClaudeModels: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(() => Option.some([])),
  ),
  claudeProjectSettings: Schema.Record(Schema.String, ClaudeProjectSettingsSchema).pipe(
    Schema.withConstructorDefault(() => Option.some({})),
  ),
  codexThreadTitleModel: Schema.String.check(Schema.isMaxLength(MAX_CUSTOM_MODEL_LENGTH)).pipe(
    Schema.withConstructorDefault(() => Option.some(DEFAULT_THREAD_TITLE_MODEL_BY_PROVIDER.codex)),
  ),
  claudeLaunchArgs: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
    Schema.withDecodingDefault(() => ""),
  ),
  addProjectBaseDirectory: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
    Schema.withDecodingDefault(() => ""),
  ),
  textGenerationModel: Schema.optional(TrimmedNonEmptyString),
});
export type AppSettings = typeof AppSettingsSchema.Type;
export interface AppModelOption {
  slug: string;
  name: string;
  isCustom: boolean;
}
export type DisplayProfilePatch = Pick<AppSettings, DisplayProfileKey>;

export function buildAppSettingsPatch<K extends keyof AppSettings>(
  keys: readonly K[],
  source: Pick<AppSettings, K>,
): Pick<AppSettings, K> {
  const patch = {} as Pick<AppSettings, K>;
  for (const key of keys) {
    patch[key] = source[key];
  }
  return patch;
}

const DEFAULT_APP_SETTINGS = AppSettingsSchema.makeUnsafe({});
export const DEFAULT_CLAUDE_PROJECT_SETTINGS = ClaudeProjectSettingsSchema.makeUnsafe({});

export function pickDisplayProfileValues(
  settings: Pick<AppSettings, DisplayProfileKey>,
): DisplayProfilePatch {
  return buildAppSettingsPatch(DISPLAY_PROFILE_KEYS, settings);
}

export function buildDisplayProfilePresets(
  defaults: AppSettings,
): Record<DisplayProfileName, DisplayProfilePatch> {
  return {
    minimal: {
      expandWorkflowThreadsByDefault: false,
      showAgentCommandTranscripts: false,
      alwaysExpandAgentCommandTranscripts: false,
      expandMcpToolCalls: false,
      expandMcpToolCallCardsByDefault: false,
      showFileChangeDiffsInline: false,
      showReasoningExpanded: false,
      runtimeWarningVisibility: "hidden",
      showProviderRuntimeMetadata: false,
    },
    balanced: pickDisplayProfileValues(defaults),
    detailed: {
      expandWorkflowThreadsByDefault: true,
      showAgentCommandTranscripts: true,
      alwaysExpandAgentCommandTranscripts: true,
      expandMcpToolCalls: true,
      expandMcpToolCallCardsByDefault: true,
      showFileChangeDiffsInline: true,
      showReasoningExpanded: true,
      runtimeWarningVisibility: "full",
      showProviderRuntimeMetadata: true,
    },
  };
}

function normalizeClaudeSubagentModel(value: string | null | undefined): string {
  if (typeof value !== "string") {
    return CLAUDE_SUBAGENT_MODEL_INHERIT;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_CUSTOM_MODEL_LENGTH) {
    return CLAUDE_SUBAGENT_MODEL_INHERIT;
  }
  return trimmed;
}

function normalizeClaudeProjectSettingsRecord(
  value: Record<string, ClaudeProjectSettings>,
): Record<string, ClaudeProjectSettings> {
  return Object.fromEntries(
    Object.entries(value)
      .map(([projectId, projectSettings]) => {
        const normalizedProjectId = projectId.trim();
        if (!normalizedProjectId) {
          return null;
        }
        return [
          normalizedProjectId,
          {
            subagentsEnabled: projectSettings.subagentsEnabled !== false,
            subagentModel: normalizeClaudeSubagentModel(projectSettings.subagentModel),
          } satisfies ClaudeProjectSettings,
        ] as const;
      })
      .filter((entry): entry is readonly [string, ClaudeProjectSettings] => entry !== null),
  );
}

function normalizeAppSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    customCodexModels: normalizeCustomModelSlugs(settings.customCodexModels, "codex"),
    customClaudeModels: normalizeCustomModelSlugs(settings.customClaudeModels, "claudeAgent"),
    claudeProjectSettings: normalizeClaudeProjectSettingsRecord(settings.claudeProjectSettings),
  };
}

export function parsePersistedAppSettings(value: string | null): AppSettings {
  if (!value) {
    return DEFAULT_APP_SETTINGS;
  }

  try {
    const parsed = JSON.parse(value) as PersistedAppSettingsValue;
    const migrated =
      parsed.showProviderRuntimeMetadata === undefined &&
      typeof parsed.showClaudeRuntimeMetadata === "boolean"
        ? {
            ...parsed,
            showProviderRuntimeMetadata: parsed.showClaudeRuntimeMetadata,
          }
        : parsed;
    return normalizeAppSettings(
      Schema.decodeUnknownSync(AppSettingsSchema)({
        ...DEFAULT_APP_SETTINGS,
        ...migrated,
        onboardingLiteStatus: normalizeOnboardingLiteStatus(migrated.onboardingLiteStatus),
        runtimeWarningVisibility: normalizeRuntimeWarningVisibility(
          migrated.runtimeWarningVisibility,
        ),
      }),
    );
  } catch {
    return DEFAULT_APP_SETTINGS;
  }
}

export const DISPLAY_PROFILE_PRESETS = buildDisplayProfilePresets(parsePersistedAppSettings(null));

export function normalizeDisplayProfileValues(values: DisplayProfilePatch): DisplayProfilePatch {
  const next = { ...values };
  if (!next.showAgentCommandTranscripts) {
    next.alwaysExpandAgentCommandTranscripts = false;
  }
  if (!next.expandMcpToolCalls) {
    next.expandMcpToolCallCardsByDefault = false;
  }
  return next;
}

export function getDisplayProfile(settings: Pick<AppSettings, DisplayProfileKey>): DisplayProfile {
  const current = normalizeDisplayProfileValues(pickDisplayProfileValues(settings));
  for (const name of DISPLAY_PROFILE_NAMES) {
    const preset = normalizeDisplayProfileValues(DISPLAY_PROFILE_PRESETS[name]);
    if (DISPLAY_PROFILE_KEYS.every((key) => current[key] === preset[key])) {
      return name;
    }
  }
  return "custom";
}

export function displayProfilePatchFor(name: DisplayProfileName): DisplayProfilePatch {
  return { ...DISPLAY_PROFILE_PRESETS[name] };
}

export function normalizeCustomModelSlugs(
  models: Iterable<string | null | undefined>,
  provider: ProviderKind = "codex",
): string[] {
  const normalizedModels: string[] = [];
  const seen = new Set<string>();
  const builtInModelSlugs = BUILT_IN_MODEL_SLUGS_BY_PROVIDER[provider];

  for (const candidate of models) {
    const normalized = normalizeModelSlug(candidate, provider);
    if (
      !normalized ||
      normalized.length > MAX_CUSTOM_MODEL_LENGTH ||
      builtInModelSlugs.has(normalized) ||
      seen.has(normalized)
    ) {
      continue;
    }

    seen.add(normalized);
    normalizedModels.push(normalized);
    if (normalizedModels.length >= MAX_CUSTOM_MODEL_COUNT) {
      break;
    }
  }

  return normalizedModels;
}

export function getAppModelOptions(
  provider: ProviderKind,
  customModels: readonly string[],
  selectedModel?: string | null,
): AppModelOption[] {
  const options: AppModelOption[] = getModelOptions(provider).map(({ slug, name }) => ({
    slug,
    name,
    isCustom: false,
  }));
  const seen = new Set(options.map((option) => option.slug));

  for (const slug of normalizeCustomModelSlugs(customModels, provider)) {
    if (seen.has(slug)) {
      continue;
    }

    seen.add(slug);
    options.push({
      slug,
      name: slug,
      isCustom: true,
    });
  }

  const normalizedSelectedModel = normalizeModelSlug(selectedModel, provider);
  if (normalizedSelectedModel && !seen.has(normalizedSelectedModel)) {
    options.push({
      slug: normalizedSelectedModel,
      name: normalizedSelectedModel,
      isCustom: true,
    });
  }

  return options;
}

export function resolveAppModelSelection(
  provider: ProviderKind,
  customModels: readonly string[],
  selectedModel: string | null | undefined,
): string {
  const options = getAppModelOptions(provider, customModels, selectedModel);
  const trimmedSelectedModel = selectedModel?.trim();
  if (trimmedSelectedModel) {
    const direct = options.find((option) => option.slug === trimmedSelectedModel);
    if (direct) {
      return direct.slug;
    }

    const byName = options.find(
      (option) => option.name.toLowerCase() === trimmedSelectedModel.toLowerCase(),
    );
    if (byName) {
      return byName.slug;
    }
  }

  const normalizedSelectedModel = normalizeModelSlug(selectedModel, provider);
  if (!normalizedSelectedModel) {
    return getDefaultModel(provider);
  }

  return (
    options.find((option) => option.slug === normalizedSelectedModel)?.slug ??
    getDefaultModel(provider)
  );
}

export function resolveAuxiliaryAppModelSelection(
  provider: ProviderKind,
  customModels: readonly string[],
  selectedModel: string | null | undefined,
  fallbackModel: string,
): string {
  const options = getAppModelOptions(provider, customModels);
  const normalizedFallback =
    normalizeModelSlug(fallbackModel, provider) ?? getDefaultModel(provider);
  const trimmedSelectedModel = selectedModel?.trim();
  if (trimmedSelectedModel) {
    const direct = options.find((option) => option.slug === trimmedSelectedModel);
    if (direct) {
      return direct.slug;
    }

    const byName = options.find(
      (option) => option.name.toLowerCase() === trimmedSelectedModel.toLowerCase(),
    );
    if (byName) {
      return byName.slug;
    }
  }

  const normalizedSelectedModel = normalizeModelSlug(selectedModel, provider);
  if (!normalizedSelectedModel) {
    return normalizedFallback;
  }

  return (
    options.find((option) => option.slug === normalizedSelectedModel)?.slug ?? normalizedFallback
  );
}

export function resolveThreadTitleModel(
  settings: Pick<AppSettings, "customCodexModels" | "codexThreadTitleModel">,
): string {
  return resolveAuxiliaryAppModelSelection(
    "codex",
    settings.customCodexModels,
    settings.codexThreadTitleModel,
    DEFAULT_THREAD_TITLE_MODEL_BY_PROVIDER.codex,
  );
}

export function getSlashModelOptions(
  provider: ProviderKind,
  customModels: readonly string[],
  query: string,
  selectedModel?: string | null,
): AppModelOption[] {
  const normalizedQuery = query.trim().toLowerCase();
  const options = getAppModelOptions(provider, customModels, selectedModel);
  if (!normalizedQuery) {
    return options;
  }

  return options.filter((option) => {
    const searchSlug = option.slug.toLowerCase();
    const searchName = option.name.toLowerCase();
    return searchSlug.includes(normalizedQuery) || searchName.includes(normalizedQuery);
  });
}

export function getClaudeProjectSettings(
  settings: Pick<AppSettings, "claudeProjectSettings">,
  projectId: string | null | undefined,
): ClaudeProjectSettings {
  if (!projectId) {
    return DEFAULT_CLAUDE_PROJECT_SETTINGS;
  }

  const projectSettings = settings.claudeProjectSettings[projectId];
  if (!projectSettings) {
    return DEFAULT_CLAUDE_PROJECT_SETTINGS;
  }

  return {
    subagentsEnabled: projectSettings.subagentsEnabled !== false,
    subagentModel: normalizeClaudeSubagentModel(projectSettings.subagentModel),
  };
}

export function useAppSettings() {
  const [settings, setSettings] = useLocalStorage(
    APP_SETTINGS_STORAGE_KEY,
    DEFAULT_APP_SETTINGS,
    AppSettingsSchema,
  );

  const updateSettings = useCallback(
    (patch: Partial<AppSettings>) => {
      setSettings((prev) => normalizeAppSettings({ ...prev, ...patch }));
    },
    [setSettings],
  );

  const resetSettings = useCallback(() => {
    setSettings(DEFAULT_APP_SETTINGS);
  }, [setSettings]);

  return {
    settings,
    updateSettings,
    resetSettings,
    defaults: DEFAULT_APP_SETTINGS,
  } as const;
}
