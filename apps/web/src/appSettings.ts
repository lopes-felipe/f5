import { useCallback, useSyncExternalStore } from "react";
import { Effect, Option, Schema, SchemaTransformation } from "effect";
import {
  DEFAULT_THREAD_TITLE_MODEL_BY_PROVIDER,
  PROJECT_LIST_ENTRIES_DEFAULT_LIMIT,
  PROJECT_LIST_ENTRIES_MAX_LIMIT,
  ProviderInstanceId,
  ProviderKind as ProviderKindSchema,
  TrimmedNonEmptyString,
  type ProviderKind,
} from "@t3tools/contracts";
import { getDefaultModel, getModelOptions, normalizeModelSlug } from "@t3tools/shared/model";
import {
  readLocalStorageRawItem,
  subscribeLocalStorageKey,
  useLocalStorage,
} from "./hooks/useLocalStorage";
import {
  CHAT_FONT_SIZE_DEFAULT,
  CHAT_FONT_SIZE_MAX,
  CHAT_FONT_SIZE_MIN,
  FONT_FAMILY_PREFERENCE_MAX_LENGTH,
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  UI_FONT_SIZE_DEFAULT,
  UI_FONT_SIZE_MAX,
  UI_FONT_SIZE_MIN,
  clampFontSize,
  normalizeAppearanceSettings,
  normalizeFontFamilyPreference,
} from "./appearanceSettings";
import { DEFAULT_THEME_ID } from "./themePalette";

export const APP_SETTINGS_STORAGE_KEY = "t3code:app-settings:v1";
const CURRENT_THEME_PALETTE_VERSION = 2 as const;
const MAX_CUSTOM_MODEL_COUNT = 32;
export const MAX_CUSTOM_MODEL_LENGTH = 256;
export const CLAUDE_SUBAGENT_MODEL_INHERIT = "inherit";
export const TIMESTAMP_FORMAT_OPTIONS = ["locale", "12-hour", "24-hour"] as const;
export type TimestampFormat = (typeof TIMESTAMP_FORMAT_OPTIONS)[number];
export const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = "locale";
export const RUNTIME_WARNING_VISIBILITY_OPTIONS = ["hidden", "summarized", "full"] as const;
export type RuntimeWarningVisibility = (typeof RUNTIME_WARNING_VISIBILITY_OPTIONS)[number];
export const WORK_LOG_MODE_OPTIONS = ["essential", "diagnostics"] as const;
export type WorkLogMode = (typeof WORK_LOG_MODE_OPTIONS)[number];
export const WORK_LOG_FILTER_OPTIONS = ["all", "tools", "hooks", "issues"] as const;
export type WorkLogFilter = (typeof WORK_LOG_FILTER_OPTIONS)[number];
export const ONBOARDING_LITE_STATUS_OPTIONS = [
  "eligible",
  "dismissed",
  "completed",
  "reopened",
] as const;
export type OnboardingLiteStatus = (typeof ONBOARDING_LITE_STATUS_OPTIONS)[number];
export interface FavoriteModel {
  providerKind: ProviderKind;
  modelId: string;
}

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
export const SIDEBAR_THREAD_PREVIEW_COUNT_MIN = 1;
export const SIDEBAR_THREAD_PREVIEW_COUNT_MAX = 15;
export const SIDEBAR_THREAD_PREVIEW_COUNT_DEFAULT = 6;
export const WORKSPACE_FILE_TREE_ENTRY_LIMIT_MIN = 5_000;
export const WORKSPACE_FILE_TREE_ENTRY_LIMIT_DEFAULT = PROJECT_LIST_ENTRIES_DEFAULT_LIMIT;
export const WORKSPACE_FILE_TREE_ENTRY_LIMIT_MAX = PROJECT_LIST_ENTRIES_MAX_LIMIT;
export const WORKSPACE_FILE_TREE_ENTRY_LIMIT_OPTIONS = [
  5_000, 10_000, 25_000, 50_000, 100_000,
] as const;
export const GIT_STATUS_AUTO_REFRESH_INTERVAL_SECONDS_DEFAULT = 60;
export const GIT_STATUS_AUTO_REFRESH_INTERVAL_SECONDS_MIN = 0;
export const GIT_STATUS_AUTO_REFRESH_INTERVAL_SECONDS_ENABLED_MIN = 5;
export const GIT_STATUS_AUTO_REFRESH_INTERVAL_SECONDS_MAX = 3600;
const BUILT_IN_MODEL_SLUGS_BY_PROVIDER: Record<ProviderKind, ReadonlySet<string>> = {
  codex: new Set(getModelOptions("codex").map((option) => option.slug)),
  claudeAgent: new Set(getModelOptions("claudeAgent").map((option) => option.slug)),
  cursor: new Set(getModelOptions("cursor").map((option) => option.slug)),
  opencode: new Set(getModelOptions("opencode").map((option) => option.slug)),
  grok: new Set(getModelOptions("grok").map((option) => option.slug)),
};

type PersistedAppSettingsValue = Record<string, unknown> & {
  readonly showClaudeRuntimeMetadata?: boolean;
  readonly showProviderRuntimeMetadata?: boolean;
  readonly onboardingLiteStatus?: unknown;
  readonly favoriteModels?: unknown;
  readonly favorites?: unknown;
  readonly providerModelPreferences?: unknown;
  readonly enableGitStatusAutoRefresh?: unknown;
  readonly gitStatusAutoRefreshIntervalSeconds?: unknown;
  readonly enablePrAttentionNotifications?: unknown;
  readonly workspaceFileTreeEntryLimit?: unknown;
  readonly uiFontFamily?: unknown;
  readonly uiFontSize?: unknown;
  readonly chatFontFamily?: unknown;
  readonly chatFontSize?: unknown;
  readonly monoFontFamily?: unknown;
  readonly terminalFontSize?: unknown;
  readonly themeId?: unknown;
  readonly themePaletteVersion?: unknown;
  readonly customThemes?: unknown;
};

const ClaudeProjectSettingsSchema = Schema.Struct({
  subagentsEnabled: Schema.Boolean.pipe(Schema.withConstructorDefault(() => Option.some(true))),
  subagentModel: Schema.String.check(Schema.isMaxLength(MAX_CUSTOM_MODEL_LENGTH)).pipe(
    Schema.withConstructorDefault(() => Option.some(CLAUDE_SUBAGENT_MODEL_INHERIT)),
  ),
});
export type ClaudeProjectSettings = typeof ClaudeProjectSettingsSchema.Type;

const FavoriteModelSchema = Schema.Struct({
  providerKind: ProviderKindSchema,
  modelId: TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_CUSTOM_MODEL_LENGTH)),
});

const SidebarThreadPreviewCountSchema = Schema.Union([Schema.Number, Schema.String]).pipe(
  Schema.decodeTo(
    Schema.Number,
    SchemaTransformation.transformOrFail({
      decode: (value) => {
        const numberValue = typeof value === "string" ? Number(value) : value;
        if (!Number.isFinite(numberValue)) {
          return Effect.succeed(SIDEBAR_THREAD_PREVIEW_COUNT_DEFAULT);
        }
        return Effect.succeed(
          Math.max(
            SIDEBAR_THREAD_PREVIEW_COUNT_MIN,
            Math.min(SIDEBAR_THREAD_PREVIEW_COUNT_MAX, Math.round(numberValue)),
          ),
        );
      },
      encode: (value) => Effect.succeed(value),
    }),
  ),
  Schema.withConstructorDefault(() => Option.some(SIDEBAR_THREAD_PREVIEW_COUNT_DEFAULT)),
  Schema.withDecodingDefault(() => SIDEBAR_THREAD_PREVIEW_COUNT_DEFAULT),
);

const GitStatusAutoRefreshIntervalSecondsSchema = Schema.Union([
  Schema.Number,
  Schema.String,
  Schema.Boolean,
]).pipe(
  Schema.decodeTo(
    Schema.Number,
    SchemaTransformation.transformOrFail({
      decode: (value) => {
        return Effect.succeed(normalizeGitStatusAutoRefreshIntervalSeconds(value));
      },
      encode: (value) => Effect.succeed(value),
    }),
  ),
  Schema.withConstructorDefault(() =>
    Option.some(GIT_STATUS_AUTO_REFRESH_INTERVAL_SECONDS_DEFAULT),
  ),
  Schema.withDecodingDefault(() => GIT_STATUS_AUTO_REFRESH_INTERVAL_SECONDS_DEFAULT),
);

const WorkspaceFileTreeEntryLimitSchema = Schema.Union([Schema.Number, Schema.String]).pipe(
  Schema.decodeTo(
    Schema.Number,
    SchemaTransformation.transformOrFail({
      decode: (value) => {
        return Effect.succeed(normalizeWorkspaceFileTreeEntryLimit(value));
      },
      encode: (value) => Effect.succeed(value),
    }),
  ),
  Schema.withConstructorDefault(() => Option.some(WORKSPACE_FILE_TREE_ENTRY_LIMIT_DEFAULT)),
  Schema.withDecodingDefault(() => WORKSPACE_FILE_TREE_ENTRY_LIMIT_DEFAULT),
);

function appearanceFontSizeSchema(minimum: number, maximum: number, fallback: number) {
  return Schema.Union([Schema.Number, Schema.String]).pipe(
    Schema.decodeTo(
      Schema.Number,
      SchemaTransformation.transformOrFail({
        decode: (value) => Effect.succeed(clampFontSize(value, minimum, maximum, fallback)),
        encode: (value) => Effect.succeed(value),
      }),
    ),
    Schema.withConstructorDefault(() => Option.some(fallback)),
    Schema.withDecodingDefault(() => fallback),
  );
}

const FontFamilyPreferenceSchema = Schema.String.check(
  Schema.isMaxLength(FONT_FAMILY_PREFERENCE_MAX_LENGTH),
).pipe(
  Schema.withConstructorDefault(() => Option.some("")),
  Schema.withDecodingDefault(() => ""),
);

const UiFontSizeSchema = appearanceFontSizeSchema(
  UI_FONT_SIZE_MIN,
  UI_FONT_SIZE_MAX,
  UI_FONT_SIZE_DEFAULT,
);
const ChatFontSizeSchema = appearanceFontSizeSchema(
  CHAT_FONT_SIZE_MIN,
  CHAT_FONT_SIZE_MAX,
  CHAT_FONT_SIZE_DEFAULT,
);
const TerminalFontSizeSchema = appearanceFontSizeSchema(
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_DEFAULT,
);

function normalizeRuntimeWarningVisibility(value: unknown): RuntimeWarningVisibility {
  if (value === "hidden" || value === "summarized" || value === "full") {
    return value;
  }
  return DEFAULT_RUNTIME_WARNING_VISIBILITY;
}

function normalizeGitStatusAutoRefreshIntervalSeconds(value: unknown): number {
  if (typeof value === "boolean") {
    return value ? GIT_STATUS_AUTO_REFRESH_INTERVAL_SECONDS_DEFAULT : 0;
  }

  const numberValue = typeof value === "string" ? Number(value) : value;
  if (typeof numberValue !== "number" || !Number.isFinite(numberValue)) {
    return GIT_STATUS_AUTO_REFRESH_INTERVAL_SECONDS_DEFAULT;
  }

  const rounded = Math.round(numberValue);
  if (rounded <= GIT_STATUS_AUTO_REFRESH_INTERVAL_SECONDS_MIN) {
    return 0;
  }

  return Math.max(
    GIT_STATUS_AUTO_REFRESH_INTERVAL_SECONDS_ENABLED_MIN,
    Math.min(GIT_STATUS_AUTO_REFRESH_INTERVAL_SECONDS_MAX, rounded),
  );
}

function normalizeWorkspaceFileTreeEntryLimit(value: unknown): number {
  const numberValue = typeof value === "string" ? Number(value) : value;
  if (typeof numberValue !== "number" || !Number.isFinite(numberValue)) {
    return WORKSPACE_FILE_TREE_ENTRY_LIMIT_DEFAULT;
  }

  return Math.max(
    WORKSPACE_FILE_TREE_ENTRY_LIMIT_MIN,
    Math.min(WORKSPACE_FILE_TREE_ENTRY_LIMIT_MAX, Math.round(numberValue)),
  );
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

export const AppSettingsSchema = Schema.Struct({
  codexBinaryPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  codexHomePath: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  claudeBinaryPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  uiFontFamily: FontFamilyPreferenceSchema,
  uiFontSize: UiFontSizeSchema,
  chatFontFamily: FontFamilyPreferenceSchema,
  chatFontSize: ChatFontSizeSchema,
  monoFontFamily: FontFamilyPreferenceSchema,
  terminalFontSize: TerminalFontSizeSchema,
  themeId: Schema.String.check(Schema.isMaxLength(64)).pipe(
    Schema.withConstructorDefault(() => Option.some(DEFAULT_THEME_ID)),
    Schema.withDecodingDefault(() => DEFAULT_THEME_ID),
  ),
  themePaletteVersion: Schema.Literal(CURRENT_THEME_PALETTE_VERSION).pipe(
    Schema.withConstructorDefault(() => Option.some(CURRENT_THEME_PALETTE_VERSION)),
    Schema.withDecodingDefault(() => CURRENT_THEME_PALETTE_VERSION),
  ),
  // Custom definitions stay opaque here so invalid imported data can fall back
  // without being deleted. themePalette.ts owns the strict, versioned parser.
  customThemes: Schema.Array(Schema.Unknown).pipe(
    Schema.withConstructorDefault(() => Option.some([])),
    Schema.withDecodingDefault(() => []),
  ),
  defaultThreadEnvMode: Schema.Literals(["local", "worktree"]).pipe(
    Schema.withConstructorDefault(() => Option.some("local")),
  ),
  tasksPanelAutoOpen: Schema.Boolean.pipe(Schema.withConstructorDefault(() => Option.some(false))),
  expandWorkflowThreadsByDefault: Schema.Boolean.pipe(
    Schema.withConstructorDefault(() => Option.some(false)),
  ),
  confirmThreadDelete: Schema.Boolean.pipe(Schema.withConstructorDefault(() => Option.some(true))),
  enableAssistantStreaming: Schema.Boolean.pipe(
    Schema.withConstructorDefault(() => Option.some(true)),
  ),
  // Legacy persisted flag. The interval is the source of truth; normalizeAppSettings derives this.
  enableGitStatusAutoRefresh: Schema.Boolean.pipe(
    Schema.withConstructorDefault(() => Option.some(true)),
  ),
  gitStatusAutoRefreshIntervalSeconds: GitStatusAutoRefreshIntervalSecondsSchema,
  enableThreadStatusNotifications: Schema.Boolean.pipe(
    Schema.withConstructorDefault(() => Option.some(true)),
  ),
  enablePrAttentionNotifications: Schema.Boolean.pipe(
    Schema.withConstructorDefault(() => Option.some(true)),
    Schema.withDecodingDefault(() => true),
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
  diffIgnoreWhitespace: Schema.Boolean.pipe(
    Schema.withConstructorDefault(() => Option.some(false)),
    Schema.withDecodingDefault(() => false),
  ),
  diffWordWrap: Schema.Boolean.pipe(
    Schema.withConstructorDefault(() => Option.some(false)),
    Schema.withDecodingDefault(() => false),
  ),
  diffRenderMode: Schema.Literals(["stacked", "split"]).pipe(
    Schema.withConstructorDefault(() => Option.some("stacked")),
    Schema.withDecodingDefault(() => "stacked" as const),
  ),
  sidebarThreadPreviewCount: SidebarThreadPreviewCountSchema,
  showReasoningExpanded: Schema.Boolean.pipe(
    Schema.withConstructorDefault(() => Option.some(DEFAULT_SHOW_REASONING_EXPANDED)),
  ),
  runtimeWarningVisibility: Schema.Literals(["hidden", "summarized", "full"]).pipe(
    Schema.withConstructorDefault(() => Option.some(DEFAULT_RUNTIME_WARNING_VISIBILITY)),
  ),
  workLogMode: Schema.Literals(WORK_LOG_MODE_OPTIONS).pipe(
    Schema.withConstructorDefault(() => Option.some("essential" as const)),
    Schema.withDecodingDefault(() => "essential" as const),
  ),
  workLogFilter: Schema.Literals(WORK_LOG_FILTER_OPTIONS).pipe(
    Schema.withConstructorDefault(() => Option.some("all" as const)),
    Schema.withDecodingDefault(() => "all" as const),
  ),
  showProviderRuntimeMetadata: Schema.Boolean.pipe(
    Schema.withConstructorDefault(() => Option.some(false)),
  ),
  onboardingLiteStatus: Schema.Literals(["eligible", "dismissed", "completed", "reopened"]).pipe(
    Schema.withConstructorDefault(() => Option.some("eligible" as const)),
    Schema.withDecodingDefault(() => "eligible" as const),
  ),
  openFileLinksInPanel: Schema.Boolean.pipe(Schema.withConstructorDefault(() => Option.some(true))),
  workspaceFileTreeEntryLimit: WorkspaceFileTreeEntryLimitSchema,
  timestampFormat: Schema.Literals(["locale", "12-hour", "24-hour"]).pipe(
    Schema.withConstructorDefault(() => Option.some(DEFAULT_TIMESTAMP_FORMAT)),
  ),
  favoriteModels: Schema.Array(FavoriteModelSchema).pipe(
    Schema.withConstructorDefault(() => Option.some([])),
    Schema.withDecodingDefault(() => []),
  ),
  favorites: Schema.Array(
    Schema.Struct({
      provider: ProviderInstanceId,
      model: TrimmedNonEmptyString,
    }),
  ).pipe(
    Schema.withConstructorDefault(() => Option.some([])),
    Schema.withDecodingDefault(() => []),
  ),
  providerModelPreferences: Schema.Record(
    ProviderInstanceId,
    Schema.Struct({
      hiddenModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => [])),
      modelOrder: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => [])),
    }),
  ).pipe(
    Schema.withConstructorDefault(() => Option.some({})),
    Schema.withDecodingDefault(() => ({})),
  ),
  dismissedProviderUpdateAdvisories: Schema.Record(
    ProviderInstanceId,
    Schema.String.check(Schema.isMaxLength(64)),
  ).pipe(
    Schema.withConstructorDefault(() => Option.some({})),
    Schema.withDecodingDefault(() => ({})),
  ),
  customCodexModels: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(() => Option.some([])),
  ),
  customClaudeModels: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(() => Option.some([])),
  ),
  customGrokModels: Schema.Array(Schema.String).pipe(
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
  shortName?: string | undefined;
  subProvider?: string | undefined;
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

function normalizeFavoriteProviderKind(value: unknown): ProviderKind | null {
  return value === "codex" ||
    value === "claudeAgent" ||
    value === "cursor" ||
    value === "opencode" ||
    value === "grok"
    ? value
    : null;
}

export function normalizeFavoriteModels(value: unknown): FavoriteModel[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalizedModels: FavoriteModel[] = [];
  const seen = new Set<string>();

  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    const providerKind = normalizeFavoriteProviderKind(candidate.providerKind);
    if (!providerKind) {
      continue;
    }
    const modelId = normalizeModelSlug(
      typeof candidate.modelId === "string" ? candidate.modelId : null,
      providerKind,
    );
    if (!modelId || modelId.length > MAX_CUSTOM_MODEL_LENGTH) {
      continue;
    }

    const key = `${providerKind}:${modelId}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalizedModels.push({ providerKind, modelId });
  }

  return normalizedModels;
}

function normalizeAppSettings(settings: AppSettings): AppSettings {
  const gitStatusAutoRefreshIntervalSeconds = normalizeGitStatusAutoRefreshIntervalSeconds(
    settings.gitStatusAutoRefreshIntervalSeconds,
  );
  const appearance = normalizeAppearanceSettings(settings);
  return {
    ...settings,
    ...appearance,
    gitStatusAutoRefreshIntervalSeconds,
    enableGitStatusAutoRefresh: gitStatusAutoRefreshIntervalSeconds > 0,
    favoriteModels: normalizeFavoriteModels(settings.favoriteModels),
    customCodexModels: normalizeCustomModelSlugs(settings.customCodexModels, "codex"),
    customClaudeModels: normalizeCustomModelSlugs(settings.customClaudeModels, "claudeAgent"),
    customGrokModels: normalizeCustomModelSlugs(settings.customGrokModels, "grok"),
    claudeProjectSettings: normalizeClaudeProjectSettingsRecord(settings.claudeProjectSettings),
    workspaceFileTreeEntryLimit: normalizeWorkspaceFileTreeEntryLimit(
      settings.workspaceFileTreeEntryLimit,
    ),
  };
}

export function parsePersistedAppSettings(value: string | null): AppSettings {
  if (!value) {
    return DEFAULT_APP_SETTINGS;
  }

  try {
    const parsed = JSON.parse(value) as PersistedAppSettingsValue;
    const runtimeMetadataMigrated =
      parsed.showProviderRuntimeMetadata === undefined &&
      typeof parsed.showClaudeRuntimeMetadata === "boolean"
        ? {
            ...parsed,
            showProviderRuntimeMetadata: parsed.showClaudeRuntimeMetadata,
          }
        : parsed;
    const migrated: PersistedAppSettingsValue = {
      ...runtimeMetadataMigrated,
      // The first palette release used `f5-default` for the blue palette.
      // Move that implicit default to the restored black palette exactly once;
      // after v2 is persisted, explicitly selecting F5 Blue remains stable.
      themeId:
        parsed.themePaletteVersion === undefined && parsed.themeId === "f5-default"
          ? DEFAULT_THEME_ID
          : runtimeMetadataMigrated.themeId,
      themePaletteVersion: CURRENT_THEME_PALETTE_VERSION,
    };
    return normalizeAppSettings(
      Schema.decodeUnknownSync(AppSettingsSchema)({
        ...DEFAULT_APP_SETTINGS,
        ...migrated,
        onboardingLiteStatus: normalizeOnboardingLiteStatus(migrated.onboardingLiteStatus),
        runtimeWarningVisibility: normalizeRuntimeWarningVisibility(
          migrated.runtimeWarningVisibility,
        ),
        favoriteModels: normalizeFavoriteModels(migrated.favoriteModels),
        uiFontFamily: normalizeFontFamilyPreference(migrated.uiFontFamily),
        chatFontFamily: normalizeFontFamilyPreference(migrated.chatFontFamily),
        monoFontFamily: normalizeFontFamilyPreference(migrated.monoFontFamily),
        gitStatusAutoRefreshIntervalSeconds:
          migrated.gitStatusAutoRefreshIntervalSeconds ??
          migrated.enableGitStatusAutoRefresh ??
          DEFAULT_APP_SETTINGS.gitStatusAutoRefreshIntervalSeconds,
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

const CUSTOM_MODEL_SUB_PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  cerebras: "Cerebras",
  deepseek: "DeepSeek",
  fireworks: "Fireworks",
  google: "Google",
  groq: "Groq",
  meta: "Meta",
  mistral: "Mistral",
  openai: "OpenAI",
  qwen: "Qwen",
  xai: "xAI",
};

function getBuiltInModelShortName(provider: ProviderKind, name: string): string | undefined {
  if (provider === "claudeAgent" && name.startsWith("Claude ")) {
    return name.slice("Claude ".length);
  }
  if (provider === "codex" && name.startsWith("GPT-")) {
    return name.slice("GPT-".length);
  }
  return undefined;
}

function getCustomModelDisplayMetadata(slug: string): {
  name: string;
  subProvider?: string | undefined;
} {
  const separatorIndex = slug.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === slug.length - 1) {
    return { name: slug };
  }

  const prefix = slug.slice(0, separatorIndex).toLowerCase();
  const subProvider = CUSTOM_MODEL_SUB_PROVIDER_LABELS[prefix];
  if (!subProvider) {
    return { name: slug };
  }

  return {
    name: slug.slice(separatorIndex + 1),
    subProvider,
  };
}

function buildAppModelOption(input: {
  provider: ProviderKind;
  slug: string;
  name: string;
  isCustom: boolean;
}): AppModelOption {
  if (input.isCustom) {
    return {
      slug: input.slug,
      isCustom: true,
      ...getCustomModelDisplayMetadata(input.slug),
    };
  }

  return {
    slug: input.slug,
    name: input.name,
    isCustom: false,
    shortName: getBuiltInModelShortName(input.provider, input.name),
  };
}

export function getAppModelOptions(
  provider: ProviderKind,
  customModels: readonly string[],
  selectedModel?: string | null,
): AppModelOption[] {
  const options: AppModelOption[] = getModelOptions(provider).map(({ slug, name }) =>
    buildAppModelOption({
      provider,
      slug,
      name,
      isCustom: false,
    }),
  );
  const seen = new Set(options.map((option) => option.slug));

  for (const slug of normalizeCustomModelSlugs(customModels, provider)) {
    if (seen.has(slug)) {
      continue;
    }

    seen.add(slug);
    options.push(
      buildAppModelOption({
        provider,
        slug,
        isCustom: true,
        name: slug,
      }),
    );
  }

  const normalizedSelectedModel = normalizeModelSlug(selectedModel, provider);
  if (normalizedSelectedModel && !seen.has(normalizedSelectedModel)) {
    options.push(
      buildAppModelOption({
        provider,
        slug: normalizedSelectedModel,
        isCustom: true,
        name: normalizedSelectedModel,
      }),
    );
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
    parsePersistedAppSettings,
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

/** Primitive selector for hot rendering paths; unrelated setting writes keep the same snapshot. */
export function useDiffWordWrap(): boolean {
  const subscribe = useCallback(
    (listener: () => void) => subscribeLocalStorageKey(APP_SETTINGS_STORAGE_KEY, listener),
    [],
  );
  const getSnapshot = useCallback(
    () => parsePersistedAppSettings(readLocalStorageRawItem(APP_SETTINGS_STORAGE_KEY)).diffWordWrap,
    [],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => DEFAULT_APP_SETTINGS.diffWordWrap);
}
