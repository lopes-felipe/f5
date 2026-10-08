import { Schema } from "effect";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";
import { ProviderInstanceId } from "./providerInstance";

/**
 * Actions whose availability depends on the live provider session, not only
 * on the adapter. Adapter-wide facts stay in `ProviderRuntimeCapabilities`.
 */
export const PROVIDER_SESSION_ACTIONS = [
  "steer",
  "rollback",
  "modelSwitch",
  "mcpReload",
  "nativeCommands",
  "nativeSessionCleanup",
] as const;
export const ProviderSessionAction = Schema.Literals(PROVIDER_SESSION_ACTIONS);
export type ProviderSessionAction = typeof ProviderSessionAction.Type;

export const ProviderSessionUnavailableCode = Schema.Literals([
  /** The adapter or executable never supports this action. */
  "unsupported",
  /** The installed executable is too old, or its version is unknown. */
  "executable-version",
  /** F5 policy (runtime mode, workflow stage, profile isolation) forbids it. */
  "policy",
  /** The session has not finished native discovery yet. */
  "discovery-pending",
  /** There is no live provider session for this thread. */
  "no-session",
  /** The caller acted on a snapshot from an older session generation. */
  "stale-generation",
]);
export type ProviderSessionUnavailableCode = typeof ProviderSessionUnavailableCode.Type;

export const ProviderSessionUnavailableReason = Schema.Struct({
  code: ProviderSessionUnavailableCode,
  message: TrimmedNonEmptyString,
});
export type ProviderSessionUnavailableReason = typeof ProviderSessionUnavailableReason.Type;

export const ProviderSessionActionSupport = Schema.Struct({
  action: ProviderSessionAction,
  supported: Schema.Boolean,
  unavailableReason: Schema.optional(ProviderSessionUnavailableReason),
});
export type ProviderSessionActionSupport = typeof ProviderSessionActionSupport.Type;

export const ProviderSessionDiscoveryOutcome = Schema.Literals([
  /** Native discovery (initialization, command catalog) is still running. */
  "pending",
  /** The session reported its native facts. */
  "discovered",
  /** The provider exposes no session discovery; adapter facts apply. */
  "static",
  /** Discovery failed; adapter facts apply and native extras are hidden. */
  "failed",
]);
export type ProviderSessionDiscoveryOutcome = typeof ProviderSessionDiscoveryOutcome.Type;

/**
 * Capabilities of one provider session generation. A generation starts each
 * time F5 launches or resumes a native session for the thread, so a browser
 * holding an older generation's snapshot is told its view is stale.
 */
export const ProviderSessionCapabilities = Schema.Struct({
  generation: NonNegativeInt,
  providerInstanceId: Schema.optional(ProviderInstanceId),
  executableVersion: Schema.optional(TrimmedNonEmptyString),
  discovery: ProviderSessionDiscoveryOutcome,
  checkedAt: IsoDateTime,
  actions: Schema.Array(ProviderSessionActionSupport),
});
export type ProviderSessionCapabilities = typeof ProviderSessionCapabilities.Type;
