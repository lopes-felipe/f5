import { UsagePriceOverride } from "./usage";
import { Effect } from "effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { IsoDateTime, ProjectId, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas";
import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  ProviderOptionSelections,
  ModelCapabilities,
} from "./model";
import { ModelSelection, RuntimeMode } from "./orchestration";
import { ProviderInstanceConfig, ProviderInstanceId } from "./providerInstance";
import { ThreadEnvMode, type ThreadEnvMode as ThreadEnvModeType } from "./threadEnvMode";
export { ThreadEnvMode };

// ── Client Settings (local-only) ───────────────────────────────

export const TimestampFormat = Schema.Literals(["locale", "12-hour", "24-hour"]);
export type TimestampFormat = typeof TimestampFormat.Type;
export const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = "locale";

export const SidebarProjectSortOrder = Schema.Literals(["updated_at", "created_at", "manual"]);
export type SidebarProjectSortOrder = typeof SidebarProjectSortOrder.Type;
export const DEFAULT_SIDEBAR_PROJECT_SORT_ORDER: SidebarProjectSortOrder = "updated_at";

export const SidebarThreadSortOrder = Schema.Literals(["updated_at", "created_at"]);
export type SidebarThreadSortOrder = typeof SidebarThreadSortOrder.Type;
export const DEFAULT_SIDEBAR_THREAD_SORT_ORDER: SidebarThreadSortOrder = "updated_at";

export const SidebarProjectGroupingMode = Schema.Literals([
  "repository",
  "repository_path",
  "separate",
]);
export type SidebarProjectGroupingMode = typeof SidebarProjectGroupingMode.Type;
export const DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE: SidebarProjectGroupingMode = "repository";

/**
 * Shared typing/defaults for settings used by schema-only consumers.
 *
 * The web application's authoritative persisted client-settings schema is
 * `apps/web/src/appSettings.ts`. Do not add web persistence fields here.
 */
export const ClientSettingsSchema = Schema.Struct({
  autoOpenPlanSidebar: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  confirmThreadArchive: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  confirmThreadDelete: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  diffWordWrap: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  // Model favorites. Historically keyed by provider kind, now
  // widened to `ProviderInstanceId` so users can favorite a specific model
  // on a custom provider instance (e.g. "Codex Personal · gpt-5") without
  // the UI collapsing it into the same bucket as the default Codex. The
  // widening is backward-compatible by construction: prior provider-kind
  // strings satisfy the `ProviderInstanceId` slug schema, so previously
  // persisted favorites decode unchanged and continue to point at the
  // default instance for their kind (because `defaultInstanceIdForDriver(kind)`
  // uses the same slug). The field name is kept as `provider` for storage
  // stability; new call sites should treat the value as an instance id.
  favorites: Schema.Array(
    Schema.Struct({
      provider: ProviderInstanceId,
      model: TrimmedNonEmptyString,
    }),
  ).pipe(Schema.withDecodingDefault(() => [])),
  providerModelPreferences: Schema.Record(
    ProviderInstanceId,
    Schema.Struct({
      hiddenModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => [])),
      modelOrder: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => [])),
    }),
  ).pipe(Schema.withDecodingDefault(() => ({}))),
  dismissedProviderUpdateAdvisories: Schema.Record(ProviderInstanceId, Schema.String).pipe(
    Schema.withDecodingDefault(() => ({})),
  ),
  sidebarProjectGroupingMode: SidebarProjectGroupingMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE),
  ),
  sidebarProjectGroupingOverrides: Schema.Record(
    TrimmedNonEmptyString,
    SidebarProjectGroupingMode,
  ).pipe(Schema.withDecodingDefault(() => ({}))),
  sidebarProjectSortOrder: SidebarProjectSortOrder.pipe(
    Schema.withDecodingDefault(() => DEFAULT_SIDEBAR_PROJECT_SORT_ORDER),
  ),
  sidebarThreadSortOrder: SidebarThreadSortOrder.pipe(
    Schema.withDecodingDefault(() => DEFAULT_SIDEBAR_THREAD_SORT_ORDER),
  ),
  timestampFormat: TimestampFormat.pipe(Schema.withDecodingDefault(() => DEFAULT_TIMESTAMP_FORMAT)),
});
export type ClientSettings = typeof ClientSettingsSchema.Type;

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = Schema.decodeSync(ClientSettingsSchema)({});

// ── Server Settings (server-authoritative) ────────────────────

const makeBinaryPathSetting = (fallback: string) =>
  TrimmedString.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformOrFail({
        decode: (value) => Effect.succeed(value || fallback),
        encode: (value) => Effect.succeed(value),
      }),
    ),
    Schema.withDecodingDefault(() => fallback),
  );

export const CustomModelSetting = Schema.Union([
  Schema.String,
  Schema.Struct({
    slug: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
    name: Schema.optionalKey(TrimmedString.check(Schema.isMaxLength(120))),
    capabilities: Schema.optionalKey(ModelCapabilities),
  }),
]);
export type CustomModelSetting = typeof CustomModelSetting.Type;

export const CodexSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  binaryPath: makeBinaryPathSetting("codex"),
  homePath: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  shadowHomePath: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  launchArgs: Schema.String.pipe(Schema.withDecodingDefault(() => "")),
  customModels: Schema.Array(CustomModelSetting).pipe(Schema.withDecodingDefault(() => [])),
});
export type CodexSettings = typeof CodexSettings.Type;

const ClaudeAutoCompactWindow = Schema.Int.check(
  Schema.makeFilter((value) => value === 0 || (value >= 100_000 && value <= 1_000_000)),
);

export const ClaudeSettings = Schema.Struct({
  autoCompactWindow: ClaudeAutoCompactWindow.pipe(Schema.withDecodingDefault(() => 0)),
  resumeCompactionPrompt: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  binaryPath: makeBinaryPathSetting("claude"),
  homePath: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  customModels: Schema.Array(CustomModelSetting).pipe(Schema.withDecodingDefault(() => [])),
  launchArgs: Schema.String.pipe(Schema.withDecodingDefault(() => "")),
});
export type ClaudeSettings = typeof ClaudeSettings.Type;

export const CursorSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  binaryPath: makeBinaryPathSetting("agent"),
  apiEndpoint: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  customModels: Schema.Array(CustomModelSetting).pipe(Schema.withDecodingDefault(() => [])),
});
export type CursorSettings = typeof CursorSettings.Type;
export const OpenCodeSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  binaryPath: makeBinaryPathSetting("opencode"),
  serverUrl: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  serverPassword: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  customModels: Schema.Array(CustomModelSetting).pipe(Schema.withDecodingDefault(() => [])),
});
export type OpenCodeSettings = typeof OpenCodeSettings.Type;

export const GrokSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  binaryPath: makeBinaryPathSetting("grok"),
  customModels: Schema.Array(CustomModelSetting).pipe(Schema.withDecodingDefault(() => [])),
});
export type GrokSettings = typeof GrokSettings.Type;

export const AntigravitySettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  customModels: Schema.Array(CustomModelSetting).pipe(Schema.withDecodingDefault(() => [])),
  nativeCompaction: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
});
export type AntigravitySettings = typeof AntigravitySettings.Type;

export const ObservabilitySettings = Schema.Struct({
  otlpTracesUrl: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  otlpMetricsUrl: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
});
export type ObservabilitySettings = typeof ObservabilitySettings.Type;

const PrHubPollIntervalSeconds = Schema.Union([
  Schema.Literal(0),
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(60)).check(Schema.isLessThanOrEqualTo(3600)),
]);

export const PrHubSettings = Schema.Struct({
  discoverNotifications: Schema.optional(Schema.Boolean),
  pollIntervalSeconds: PrHubPollIntervalSeconds.pipe(Schema.withDecodingDefault(() => 180)),
  excludeRepos: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => [])),
});
export type PrHubSettings = typeof PrHubSettings.Type;

export const SourceControlWritingSettings = Schema.Struct({
  useRepositoryInstructions: Schema.optionalKey(Schema.Boolean),
  commitMessageStyle: Schema.Literals(["conventional", "plain"]).pipe(
    Schema.withDecodingDefault(() => "plain" as const),
  ),
  commitMessageIncludeBody: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  prBodyTemplate: TrimmedString.pipe(
    Schema.withDecodingDefault(() => "## Summary\n\n{{summary}}\n\n## Testing\n\n{{testing}}"),
  ),
  branchNamePrefix: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  customInstructions: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  generateCommitMessages: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  generatePrContent: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
});
export type SourceControlWritingSettings = typeof SourceControlWritingSettings.Type;

const SourceControlWritingSettingsPatch = Schema.Struct({
  useRepositoryInstructions: Schema.optionalKey(Schema.Boolean),
  commitMessageStyle: Schema.optionalKey(Schema.Literals(["conventional", "plain"])),
  commitMessageIncludeBody: Schema.optionalKey(Schema.Boolean),
  prBodyTemplate: Schema.optionalKey(Schema.String),
  branchNamePrefix: Schema.optionalKey(Schema.String),
  customInstructions: Schema.optionalKey(Schema.String),
  generateCommitMessages: Schema.optionalKey(Schema.Boolean),
  generatePrContent: Schema.optionalKey(Schema.Boolean),
});

export const WorktreeSubmodules = Schema.Literals(["none", "shallow", "recursive"]);
export type WorktreeSubmodules = typeof WorktreeSubmodules.Type;

/** Days, or null for "never". */
export const StorageRetentionDays = Schema.NullOr(
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3650 })),
);
export type StorageRetentionDays = typeof StorageRetentionDays.Type;

/**
 * When an idle managed worktree may be removed. Removal keeps the branch and
 * the thread's worktree path, so resuming the thread recreates the checkout.
 */
export const WorktreeCleanupRules = Schema.Struct({
  /** Remove after the thread has been idle this many days. */
  afterDays: StorageRetentionDays.pipe(Schema.withDecodingDefault(() => null)),
  /** Remove once HEAD is in the default branch and the branch's PR is merged. */
  onMerge: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  /** Remove once the thread is deleted. */
  onDelete: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  /** Remove when HEAD has no commits beyond the default branch. */
  unchanged: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
});
export type WorktreeCleanupRules = typeof WorktreeCleanupRules.Type;

/** A project's worktree cleanup policy; absent or null inherits the global rules. */
export const WorktreeCleanup = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("off") }),
  Schema.Struct({ mode: Schema.Literal("custom"), rules: WorktreeCleanupRules }),
]);
export type WorktreeCleanup = typeof WorktreeCleanup.Type;

export const StorageCleanupSettings = Schema.Struct({
  /** Master switch for automatic cleanup. Off by default. */
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  worktree: WorktreeCleanupRules.pipe(Schema.withDecodingDefault(() => ({}))),
  providerLogsAfterDays: StorageRetentionDays.pipe(Schema.withDecodingDefault(() => null)),
  /** Desktop preview screenshots and recordings; null keeps the 7-day default. */
  previewArtifactRetentionDays: StorageRetentionDays.pipe(Schema.withDecodingDefault(() => null)),
  /**
   * Permanently purge archived threads this many days after archiving. Needs
   * `enabled`; null (the default) keeps archived threads.
   */
  archivedThreadsPurgeAfterDays: StorageRetentionDays.pipe(Schema.withDecodingDefault(() => null)),
  /**
   * Purge deleted threads' rows, events, attachments and logs this many days
   * after deletion. Runs even when `enabled` is off: nothing can open a
   * deleted thread again. Null never purges.
   */
  deletedThreadsPurgeAfterDays: StorageRetentionDays.pipe(Schema.withDecodingDefault(() => 7)),
  /**
   * Delete per-thread provider logs of deleted and archived threads once they
   * have not been written for this many days. Runs even when `enabled` is
   * off; live threads keep their logs for transcript repair. Null keeps them.
   */
  terminalThreadLogsAfterDays: StorageRetentionDays.pipe(Schema.withDecodingDefault(() => 14)),
});
export type StorageCleanupSettings = typeof StorageCleanupSettings.Type;

const StorageCleanupSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  worktree: Schema.optionalKey(
    Schema.Struct({
      afterDays: Schema.optionalKey(StorageRetentionDays),
      onMerge: Schema.optionalKey(Schema.Boolean),
      onDelete: Schema.optionalKey(Schema.Boolean),
      unchanged: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  providerLogsAfterDays: Schema.optionalKey(StorageRetentionDays),
  previewArtifactRetentionDays: Schema.optionalKey(StorageRetentionDays),
  archivedThreadsPurgeAfterDays: Schema.optionalKey(StorageRetentionDays),
  deletedThreadsPurgeAfterDays: Schema.optionalKey(StorageRetentionDays),
  terminalThreadLogsAfterDays: Schema.optionalKey(StorageRetentionDays),
});

export const ProjectSettingsOverrides = Schema.Struct({
  autoResumeUsageLimitedThreads: Schema.optionalKey(Schema.Boolean),
  resumeActiveTurnsAfterRestart: Schema.optionalKey(Schema.Boolean),
  defaultRuntimeMode: Schema.optionalKey(RuntimeMode),
  defaultThreadEnvMode: Schema.optionalKey(ThreadEnvMode),
  worktreeSubmodules: Schema.optionalKey(WorktreeSubmodules),
  textGenerationModelSelection: Schema.optionalKey(ModelSelection),
  sourceControlWriting: Schema.optionalKey(SourceControlWritingSettingsPatch),
  enableAssistantStreaming: Schema.optionalKey(Schema.Boolean),
  prHubDefaultMergeMethod: Schema.optionalKey(
    Schema.NullOr(Schema.Literals(["squash", "merge", "rebase"])),
  ),
  worktreeCleanup: Schema.optionalKey(Schema.NullOr(WorktreeCleanup)),
  enableAgentBrowserAccess: Schema.optionalKey(Schema.Boolean),
  autoPullDefaultBranch: Schema.optionalKey(Schema.Boolean),
});
export type ProjectSettingsOverrides = typeof ProjectSettingsOverrides.Type;

export const ServerSettings = Schema.Struct({
  usagePriceOverrides: Schema.Array(UsagePriceOverride).pipe(Schema.withDecodingDefault(() => [])),
  autoResumeUsageLimitedThreads: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  resumeActiveTurnsAfterRestart: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  defaultRuntimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(() => "full-access" as const)),
  worktreeSubmodules: WorktreeSubmodules.pipe(
    Schema.withDecodingDefault(() => "recursive" as const),
  ),
  projectSettingsOverrides: Schema.Record(ProjectId, ProjectSettingsOverrides).pipe(
    Schema.withDecodingDefault(() => ({})),
  ),
  clientSettingMigrations: Schema.Record(Schema.String, IsoDateTime).pipe(
    Schema.withDecodingDefault(() => ({})),
  ),
  gitAuthorName: Schema.String.pipe(Schema.withDecodingDefault(() => "")),
  gitAuthorEmail: Schema.String.pipe(Schema.withDecodingDefault(() => "")),
  enableAssistantStreaming: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  enableProviderUpdateChecks: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  defaultThreadEnvMode: ThreadEnvMode.pipe(
    Schema.withDecodingDefault(() => "local" as const satisfies ThreadEnvModeType),
  ),
  addProjectBaseDirectory: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  textGenerationModelSelection: ModelSelection.pipe(
    Schema.withDecodingDefault(() => ({
      instanceId: ProviderInstanceId.make("codex"),
      model: DEFAULT_GIT_TEXT_GENERATION_MODEL,
    })),
  ),
  sessionNotesModelSelection: ModelSelection.pipe(
    Schema.withDecodingDefault(() => ({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-luna",
      options: [{ id: "reasoningEffort", value: "low" }],
    })),
  ),
  prHubDefaultMergeMethod: Schema.NullOr(Schema.Literals(["squash", "merge", "rebase"])).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  sourceControlWriting: SourceControlWritingSettings.pipe(Schema.withDecodingDefault(() => ({}))),
  storageCleanup: StorageCleanupSettings.pipe(Schema.withDecodingDefault(() => ({}))),
  /** Project-scopable worktree cleanup policy; null uses `storageCleanup.worktree`. */
  worktreeCleanup: Schema.NullOr(WorktreeCleanup).pipe(Schema.withDecodingDefault(() => null)),
  /** Fast-forward clean default branches in the background. Off by default. */
  enableAgentBrowserAccess: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  autoPullDefaultBranch: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),

  // Legacy single-instance-per-driver settings. Continues to be the source
  // of truth until `providerInstances` (below) lands per-driver migration
  // shims and the server starts hydrating instances from it. Driver-specific
  // schemas live here for the duration of the migration; once each driver
  // owns its config in its own package, this struct shrinks to nothing and
  // is removed entirely.
  providers: Schema.Struct({
    codex: CodexSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    claudeAgent: ClaudeSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    cursor: CursorSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    opencode: OpenCodeSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    grok: GrokSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    antigravity: AntigravitySettings.pipe(Schema.withDecodingDefault(() => ({}))),
  }).pipe(Schema.withDecodingDefault(() => ({}))),
  // New driver-agnostic instance map. Keyed by `ProviderInstanceId`; values
  // are `ProviderInstanceConfig` envelopes. The driver-specific config blob
  // is `Schema.Unknown` at this layer so envelopes with unknown drivers
  // (forks, downgrades, in-flight PR branches) round-trip without loss.
  // See providerInstance.ts for the forward/backward compatibility invariant.
  providerInstances: Schema.Record(ProviderInstanceId, ProviderInstanceConfig).pipe(
    Schema.withDecodingDefault(() => ({})),
  ),
  observability: ObservabilitySettings.pipe(Schema.withDecodingDefault(() => ({}))),
  prHub: PrHubSettings.pipe(Schema.withDecodingDefault(() => ({}))),
});
export type ServerSettings = typeof ServerSettings.Type;

export const DEFAULT_SERVER_SETTINGS: ServerSettings = Schema.decodeSync(ServerSettings)({});

export class ServerSettingsError extends Schema.TaggedErrorClass<ServerSettingsError>()(
  "ServerSettingsError",
  {
    settingsPath: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Server settings error at ${this.settingsPath}: ${this.detail}`;
  }
}

// ── Unified type ─────────────────────────────────────────────────────

export type UnifiedSettings = ServerSettings & ClientSettings;
export const DEFAULT_UNIFIED_SETTINGS: UnifiedSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  ...DEFAULT_CLIENT_SETTINGS,
};

// ── Server Settings Patch (replace with a Schema.deepPartial if available) ──────────────────────────────────────────

const ModelSelectionPatch = Schema.Struct({
  instanceId: Schema.optionalKey(ProviderInstanceId),
  model: Schema.optionalKey(TrimmedNonEmptyString),
  options: Schema.optionalKey(ProviderOptionSelections),
});

const CodexSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  homePath: Schema.optionalKey(Schema.String),
  shadowHomePath: Schema.optionalKey(Schema.String),
  launchArgs: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(CustomModelSetting)),
});

const ClaudeSettingsPatch = Schema.Struct({
  autoCompactWindow: Schema.optionalKey(ClaudeAutoCompactWindow),
  resumeCompactionPrompt: Schema.optionalKey(Schema.Boolean),
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  homePath: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(CustomModelSetting)),
  launchArgs: Schema.optionalKey(Schema.String),
});

const CursorSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  apiEndpoint: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(CustomModelSetting)),
});

const OpenCodeSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  serverUrl: Schema.optionalKey(Schema.String),
  serverPassword: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(CustomModelSetting)),
});

const GrokSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(CustomModelSetting)),
});

const PrHubSettingsPatch = Schema.Struct({
  pollIntervalSeconds: Schema.optionalKey(PrHubPollIntervalSeconds),
  excludeRepos: Schema.optionalKey(Schema.Array(Schema.String)),
});

export const ServerSettingsPatch = Schema.Struct({
  usagePriceOverrides: Schema.optionalKey(Schema.Array(UsagePriceOverride)),
  autoResumeUsageLimitedThreads: Schema.optionalKey(Schema.Boolean),
  resumeActiveTurnsAfterRestart: Schema.optionalKey(Schema.Boolean),
  defaultRuntimeMode: Schema.optionalKey(RuntimeMode),
  worktreeSubmodules: Schema.optionalKey(WorktreeSubmodules),
  projectSettingsOverrides: Schema.optionalKey(
    Schema.Record(ProjectId, Schema.NullOr(ProjectSettingsOverrides)),
  ),
  gitAuthorName: Schema.optionalKey(Schema.String),
  gitAuthorEmail: Schema.optionalKey(Schema.String),
  // Server settings
  enableAssistantStreaming: Schema.optionalKey(Schema.Boolean),
  enableProviderUpdateChecks: Schema.optionalKey(Schema.Boolean),
  defaultThreadEnvMode: Schema.optionalKey(ThreadEnvMode),
  addProjectBaseDirectory: Schema.optionalKey(Schema.String),
  textGenerationModelSelection: Schema.optionalKey(ModelSelectionPatch),
  sessionNotesModelSelection: Schema.optionalKey(ModelSelectionPatch),
  prHubDefaultMergeMethod: Schema.optionalKey(
    Schema.NullOr(Schema.Literals(["squash", "merge", "rebase"])),
  ),
  sourceControlWriting: Schema.optionalKey(SourceControlWritingSettingsPatch),
  storageCleanup: Schema.optionalKey(StorageCleanupSettingsPatch),
  worktreeCleanup: Schema.optionalKey(Schema.NullOr(WorktreeCleanup)),
  enableAgentBrowserAccess: Schema.optionalKey(Schema.Boolean),
  autoPullDefaultBranch: Schema.optionalKey(Schema.Boolean),
  observability: Schema.optionalKey(
    Schema.Struct({
      otlpTracesUrl: Schema.optionalKey(Schema.String),
      otlpMetricsUrl: Schema.optionalKey(Schema.String),
    }),
  ),
  prHub: Schema.optionalKey(PrHubSettingsPatch),
  providers: Schema.optionalKey(
    Schema.Struct({
      codex: Schema.optionalKey(CodexSettingsPatch),
      claudeAgent: Schema.optionalKey(ClaudeSettingsPatch),
      cursor: Schema.optionalKey(CursorSettingsPatch),
      opencode: Schema.optionalKey(OpenCodeSettingsPatch),
      grok: Schema.optionalKey(GrokSettingsPatch),
      antigravity: Schema.optionalKey(
        Schema.Struct({
          enabled: Schema.optionalKey(Schema.Boolean),
          customModels: Schema.optionalKey(Schema.Array(CustomModelSetting)),
          nativeCompaction: Schema.optionalKey(Schema.Boolean),
        }),
      ),
    }),
  ),
  // Whole-map replacement for the new instance config. Patching individual
  // entries is intentionally out of scope: the map is small, and partial
  // patches risk leaving driver-specific config in a half-merged state.
  // The web UI sends a fully-formed map every time it edits this field.
  providerInstances: Schema.optionalKey(Schema.Record(ProviderInstanceId, ProviderInstanceConfig)),
});
export type ServerSettingsPatch = typeof ServerSettingsPatch.Type;

export const PROJECT_SCOPED_SERVER_SETTING_KEYS = [
  "resumeActiveTurnsAfterRestart",
  "autoResumeUsageLimitedThreads",
  "defaultRuntimeMode",
  "defaultThreadEnvMode",
  "worktreeSubmodules",
  "textGenerationModelSelection",
  "sourceControlWriting",
  "enableAssistantStreaming",
  "prHubDefaultMergeMethod",
  "worktreeCleanup",
  "enableAgentBrowserAccess",
  "autoPullDefaultBranch",
] as const satisfies ReadonlyArray<keyof ServerSettings>;
export type ProjectScopedServerSettingKey = (typeof PROJECT_SCOPED_SERVER_SETTING_KEYS)[number];
export const ProjectSettingSource = Schema.Literals([
  "project",
  "legacy-project",
  "f5.json",
  "t3.json",
  "global",
  "default",
]);
export const ProjectSettingsResult = Schema.Struct({
  settings: ServerSettings,
  sources: Schema.Record(Schema.Literals(PROJECT_SCOPED_SERVER_SETTING_KEYS), ProjectSettingSource),
  overrides: ProjectSettingsOverrides,
});
export type ProjectSettingsResult = typeof ProjectSettingsResult.Type;
export const MigrateClientSettingInput = Schema.Union([
  Schema.Struct({ key: Schema.Literal("defaultThreadEnvMode"), value: ThreadEnvMode }),
  Schema.Struct({ key: Schema.Literal("enableAssistantStreaming"), value: Schema.Boolean }),
]);
export type MigrateClientSettingInput = typeof MigrateClientSettingInput.Type;
export const MigrateClientSettingResult = Schema.Struct({
  applied: Schema.Boolean,
  currentValue: Schema.Union([ThreadEnvMode, Schema.Boolean]),
});
export type MigrateClientSettingResult = typeof MigrateClientSettingResult.Type;
