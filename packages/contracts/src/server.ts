import { Schema } from "effect";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas";
import { KeybindingRule, KeybindingsConfig, ResolvedKeybindingsConfig } from "./keybindings";
import { EditorId } from "./editor";
import { ModelCapabilities } from "./model";
import { ProviderKind, ProviderStartOptions } from "./orchestration";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance";
import { ServerSettings } from "./settings";

const KeybindingsMalformedConfigIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.malformed-config"),
  message: TrimmedNonEmptyString,
});

const KeybindingsInvalidEntryIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.invalid-entry"),
  message: TrimmedNonEmptyString,
  index: Schema.Number,
});

export const ServerConfigIssue = Schema.Union([
  KeybindingsMalformedConfigIssue,
  KeybindingsInvalidEntryIssue,
]);
export type ServerConfigIssue = typeof ServerConfigIssue.Type;

const ServerConfigIssues = Schema.Array(ServerConfigIssue);
const ServerProviderLatestVersionString = TrimmedNonEmptyString.check(Schema.isMaxLength(64));

export const ServerProviderStatusState = Schema.Literals(["ready", "warning", "error"]);
export type ServerProviderStatusState = typeof ServerProviderStatusState.Type;

export const ServerProviderAuthStatus = Schema.Literals([
  "authenticated",
  "unauthenticated",
  "unknown",
]);
export type ServerProviderAuthStatus = typeof ServerProviderAuthStatus.Type;

export const ServerProviderStatus = Schema.Struct({
  provider: ProviderKind,
  status: ServerProviderStatusState,
  available: Schema.Boolean,
  authStatus: ServerProviderAuthStatus,
  checkedAt: IsoDateTime,
  version: Schema.optional(TrimmedNonEmptyString),
  message: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderStatus = typeof ServerProviderStatus.Type;

export const ServerProviderState = Schema.Literals(["ready", "warning", "error", "disabled"]);
export type ServerProviderState = typeof ServerProviderState.Type;

export const ServerProviderProbeOutcome = Schema.Literals([
  "loading",
  "success",
  "transient_failure",
  "disabled",
  "missing",
]);
export type ServerProviderProbeOutcome = typeof ServerProviderProbeOutcome.Type;

export const ServerProviderAuth = Schema.Struct({
  status: ServerProviderAuthStatus,
  type: Schema.optional(TrimmedNonEmptyString),
  label: Schema.optional(TrimmedNonEmptyString),
  email: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderAuth = typeof ServerProviderAuth.Type;

export const ServerProviderModel = Schema.Struct({
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  shortName: Schema.optional(TrimmedNonEmptyString),
  subProvider: Schema.optional(TrimmedNonEmptyString),
  isCustom: Schema.Boolean,
  capabilities: Schema.NullOr(ModelCapabilities),
});
export type ServerProviderModel = typeof ServerProviderModel.Type;

export const ServerProviderSlashCommandInput = Schema.Struct({
  hint: TrimmedNonEmptyString,
});
export type ServerProviderSlashCommandInput = typeof ServerProviderSlashCommandInput.Type;

export const ServerProviderSlashCommand = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  input: Schema.optional(ServerProviderSlashCommandInput),
});
export type ServerProviderSlashCommand = typeof ServerProviderSlashCommand.Type;

export const ServerProviderSkill = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  path: TrimmedNonEmptyString,
  scope: Schema.optional(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
  displayName: Schema.optional(TrimmedNonEmptyString),
  shortDescription: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderSkill = typeof ServerProviderSkill.Type;

export const ServerProviderAvailability = Schema.Literals(["available", "unavailable"]);
export type ServerProviderAvailability = typeof ServerProviderAvailability.Type;

export const ServerProviderContinuation = Schema.Struct({
  groupKey: TrimmedNonEmptyString,
});
export type ServerProviderContinuation = typeof ServerProviderContinuation.Type;

export const ServerProviderVersionAdvisoryStatus = Schema.Literals([
  "unknown",
  "current",
  "behind_latest",
]);
export type ServerProviderVersionAdvisoryStatus = typeof ServerProviderVersionAdvisoryStatus.Type;

export const ServerProviderUpdateCommand = Schema.Struct({
  executable: TrimmedNonEmptyString,
  args: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => [])),
  channel: Schema.Literals(["npm"]),
  cwd: Schema.optional(TrimmedNonEmptyString),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type ServerProviderUpdateCommand = typeof ServerProviderUpdateCommand.Type;

export const ServerProviderVersionAdvisory = Schema.Struct({
  status: ServerProviderVersionAdvisoryStatus,
  currentVersion: Schema.NullOr(TrimmedNonEmptyString),
  latestVersion: Schema.NullOr(ServerProviderLatestVersionString),
  updateCommand: Schema.NullOr(ServerProviderUpdateCommand),
  checkedAt: Schema.NullOr(IsoDateTime),
  message: Schema.NullOr(TrimmedNonEmptyString),
});
export type ServerProviderVersionAdvisory = typeof ServerProviderVersionAdvisory.Type;

export const ServerProvider = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: Schema.optional(TrimmedNonEmptyString),
  accentColor: Schema.optional(TrimmedNonEmptyString),
  badgeLabel: Schema.optional(TrimmedNonEmptyString),
  continuation: Schema.optional(ServerProviderContinuation),
  showInteractionModeToggle: Schema.optional(Schema.Boolean),
  enabled: Schema.Boolean,
  installed: Schema.Boolean,
  version: Schema.NullOr(TrimmedNonEmptyString),
  status: ServerProviderState,
  auth: ServerProviderAuth,
  checkedAt: IsoDateTime,
  probeOutcome: Schema.optional(ServerProviderProbeOutcome),
  probeOutcomeStartedAt: Schema.optional(IsoDateTime),
  configurationFingerprint: Schema.optional(TrimmedNonEmptyString),
  message: Schema.optional(TrimmedNonEmptyString),
  availability: Schema.optional(ServerProviderAvailability),
  unavailableReason: Schema.optional(TrimmedNonEmptyString),
  versionAdvisory: Schema.optional(ServerProviderVersionAdvisory),
  models: Schema.Array(ServerProviderModel),
  slashCommands: Schema.Array(ServerProviderSlashCommand).pipe(
    Schema.withDecodingDefault(() => []),
  ),
  skills: Schema.Array(ServerProviderSkill).pipe(Schema.withDecodingDefault(() => [])),
});
export type ServerProvider = typeof ServerProvider.Type;

export const ServerProviders = Schema.Array(ServerProvider);
export type ServerProviders = typeof ServerProviders.Type;

export const isProviderAvailable = (snapshot: ServerProvider): boolean =>
  snapshot.availability !== "unavailable";

export const ServerProviderUpdatedPayload = Schema.Struct({
  providers: ServerProviders,
});
export type ServerProviderUpdatedPayload = typeof ServerProviderUpdatedPayload.Type;

export const ServerProviderAdvisoryEntry = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  versionAdvisory: ServerProviderVersionAdvisory,
});
export type ServerProviderAdvisoryEntry = typeof ServerProviderAdvisoryEntry.Type;

export const ServerProviderAdvisoriesUpdatedPayload = Schema.Struct({
  advisories: Schema.Array(ServerProviderAdvisoryEntry),
});
export type ServerProviderAdvisoriesUpdatedPayload =
  typeof ServerProviderAdvisoriesUpdatedPayload.Type;

export const HarnessValidationFailureKind = Schema.Literals([
  "notInstalled",
  "unsupportedVersion",
  "versionProbeFailed",
  "versionProbeTimeout",
  "unauthenticated",
  "preflight",
  "connectivity",
]);
export type HarnessValidationFailureKind = typeof HarnessValidationFailureKind.Type;

export const ServerHarnessValidationResult = Schema.Struct({
  provider: ProviderKind,
  status: Schema.Literals(["ready", "error"]),
  installed: Schema.Boolean,
  authStatus: ServerProviderAuthStatus,
  failureKind: Schema.optional(HarnessValidationFailureKind),
  checkedAt: IsoDateTime,
  version: Schema.optional(TrimmedNonEmptyString),
  message: Schema.optional(TrimmedNonEmptyString),
});
export type ServerHarnessValidationResult = typeof ServerHarnessValidationResult.Type;

export const ServerValidateHarnessesInput = Schema.Struct({
  providerOptions: Schema.optional(ProviderStartOptions),
});
export type ServerValidateHarnessesInput = typeof ServerValidateHarnessesInput.Type;

export const ServerValidateHarnessesResult = Schema.Struct({
  results: Schema.Array(ServerHarnessValidationResult),
});
export type ServerValidateHarnessesResult = typeof ServerValidateHarnessesResult.Type;

export const ServerConfig = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  keybindingsConfigPath: TrimmedNonEmptyString,
  keybindings: ResolvedKeybindingsConfig,
  customKeybindings: KeybindingsConfig.pipe(Schema.withDecodingDefault(() => [])),
  issues: ServerConfigIssues,
  providers: ServerProviders,
  availableEditors: Schema.Array(EditorId),
  settings: Schema.optional(ServerSettings),
});
export type ServerConfig = typeof ServerConfig.Type;

export const ServerUpsertKeybindingInput = KeybindingRule;
export type ServerUpsertKeybindingInput = typeof ServerUpsertKeybindingInput.Type;

export const ServerUpsertKeybindingResult = Schema.Struct({
  keybindings: ResolvedKeybindingsConfig,
  customKeybindings: KeybindingsConfig.pipe(Schema.withDecodingDefault(() => [])),
  issues: ServerConfigIssues,
});
export type ServerUpsertKeybindingResult = typeof ServerUpsertKeybindingResult.Type;

export const ServerAddKeybindingInput = Schema.Struct({
  rule: KeybindingRule,
});
export type ServerAddKeybindingInput = typeof ServerAddKeybindingInput.Type;

export const ServerUpdateKeybindingInput = Schema.Struct({
  target: KeybindingRule,
  rule: KeybindingRule,
});
export type ServerUpdateKeybindingInput = typeof ServerUpdateKeybindingInput.Type;

export const ServerRemoveKeybindingInput = Schema.Struct({
  target: KeybindingRule,
});
export type ServerRemoveKeybindingInput = typeof ServerRemoveKeybindingInput.Type;

export const ServerResetKeybindingsInput = Schema.Struct({});
export type ServerResetKeybindingsInput = typeof ServerResetKeybindingsInput.Type;

export const ServerKeybindingMutationResult = ServerUpsertKeybindingResult;
export type ServerKeybindingMutationResult = typeof ServerKeybindingMutationResult.Type;

export const ServerConfigUpdatedPayload = Schema.Struct({
  source: Schema.optionalKey(Schema.Literals(["keybindings", "settings", "providers"])),
  issues: ServerConfigIssues,
  providers: ServerProviders,
  settings: Schema.optional(ServerSettings),
});
export type ServerConfigUpdatedPayload = typeof ServerConfigUpdatedPayload.Type;

export const ServerConfigProviderStatusesPayload = Schema.Struct({
  providers: ServerProviders,
});
export type ServerConfigProviderStatusesPayload = typeof ServerConfigProviderStatusesPayload.Type;

export const ServerConfigSettingsUpdatedPayload = Schema.Struct({
  settings: ServerSettings,
});
export type ServerConfigSettingsUpdatedPayload = typeof ServerConfigSettingsUpdatedPayload.Type;
