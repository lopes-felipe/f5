/**
 * Session capability snapshots.
 *
 * `ProviderRuntimeCapabilities` describes what an adapter and executable can
 * do. A session snapshot narrows that to one live session generation: whether
 * the session exists, whether native discovery finished, and which actions F5
 * may route to it right now, each with a structured reason when unavailable.
 *
 * @module provider/sessionCapabilities
 */
import {
  PROVIDER_SESSION_ACTIONS,
  type ProviderInstanceId,
  type ProviderRuntimeCapabilities,
  type ProviderSessionAction,
  type ProviderSessionActionSupport,
  type ProviderSessionCapabilities,
  type ProviderSessionDiscoveryOutcome,
  type ProviderSessionUnavailableReason,
} from "@t3tools/contracts";
import { providerRuntimeCapabilities } from "@t3tools/shared/providerRuntimeCapabilities";

import type { ProviderAdapterCapabilities } from "./Services/ProviderAdapter.ts";
import { isRecord } from "./runtimePayload.ts";

/** Native discovery facts an adapter reports for one live session. */
export interface ProviderSessionDiscovery {
  readonly outcome: Exclude<ProviderSessionDiscoveryOutcome, "static">;
  /** The session published its native command catalog. */
  readonly nativeCommands?: boolean;
}

export interface BuildProviderSessionCapabilitiesInput {
  readonly generation: number;
  readonly driver: string;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
  readonly executableVersion?: string | null | undefined;
  readonly adapterCapabilities: ProviderAdapterCapabilities;
  readonly hasSteer: boolean;
  readonly hasMcpReload: boolean;
  /** Whether the adapter currently owns a live session for the thread. */
  readonly active: boolean;
  /** Undefined when the adapter exposes no discovery. */
  readonly discovery?: ProviderSessionDiscovery | undefined;
  readonly checkedAt: string;
}

const unavailable = (
  code: ProviderSessionUnavailableReason["code"],
  message: string,
): ProviderSessionUnavailableReason => ({ code, message });

function supportFor(
  action: ProviderSessionAction,
  runtime: ProviderRuntimeCapabilities,
  input: BuildProviderSessionCapabilitiesInput,
): ProviderSessionActionSupport {
  const refuse = (reason: ProviderSessionUnavailableReason): ProviderSessionActionSupport => ({
    action,
    supported: false,
    unavailableReason: reason,
  });
  const noSession = () =>
    refuse(unavailable("no-session", "This conversation has no running provider session."));
  switch (action) {
    case "steer":
      if (!runtime.turnSteering || !input.hasSteer)
        return refuse(unavailable("unsupported", "This provider cannot steer a running turn."));
      return input.active ? { action, supported: true } : noSession();
    case "rollback":
      // ProviderService recovers a stopped session before rolling back.
      return runtime.conversationRollback && runtime.rollbackReadback
        ? { action, supported: true }
        : refuse(
            unavailable(
              "unsupported",
              "This provider cannot reliably rewind and verify its conversation history.",
            ),
          );
    case "modelSwitch":
      if (input.adapterCapabilities.sessionModelSwitch === "unsupported")
        return refuse(
          unavailable("unsupported", "This provider cannot change models in a session."),
        );
      return { action, supported: true };
    case "mcpReload":
      if (!input.hasMcpReload)
        return refuse(
          unavailable("unsupported", "This provider reloads MCP servers only on restart."),
        );
      return input.active ? { action, supported: true } : noSession();
    case "nativeCommands":
      if (!runtime.sessionCommandCatalog)
        return refuse(unavailable("unsupported", "This provider publishes no command catalog."));
      if (!input.active) return noSession();
      if (input.discovery?.outcome === "pending")
        return refuse(
          unavailable("discovery-pending", "The provider is still loading its commands."),
        );
      if (input.discovery?.outcome === "failed" || input.discovery?.nativeCommands === false)
        return refuse(unavailable("unsupported", "The provider did not report its commands."));
      return { action, supported: true };
    case "nativeSessionCleanup":
      return runtime.nativeSessionCleanup
        ? { action, supported: true }
        : refuse(
            unavailable("unsupported", "This provider keeps no transcripts for F5 to delete."),
          );
  }
}

export function buildProviderSessionCapabilities(
  input: BuildProviderSessionCapabilitiesInput,
): ProviderSessionCapabilities {
  const runtime = providerRuntimeCapabilities(input.driver, input.executableVersion);
  const executableVersion = input.executableVersion?.trim();
  return {
    generation: input.generation,
    ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
    ...(executableVersion ? { executableVersion } : {}),
    discovery: input.discovery?.outcome ?? "static",
    checkedAt: input.checkedAt,
    actions: PROVIDER_SESSION_ACTIONS.map((action) => supportFor(action, runtime, input)),
  };
}

export function sessionActionSupport(
  capabilities: ProviderSessionCapabilities | null | undefined,
  action: ProviderSessionAction,
): ProviderSessionActionSupport | undefined {
  return capabilities?.actions.find((entry) => entry.action === action);
}

/**
 * Re-check an action before routing it. A caller that names an expected
 * generation is refused when the session was relaunched since it looked.
 */
export function checkSessionAction(input: {
  readonly capabilities: ProviderSessionCapabilities;
  readonly action: ProviderSessionAction;
  readonly expectedGeneration?: number | undefined;
}): ProviderSessionUnavailableReason | undefined {
  if (
    input.expectedGeneration !== undefined &&
    input.expectedGeneration !== input.capabilities.generation
  ) {
    return unavailable(
      "stale-generation",
      "The provider session restarted since this view loaded. Reload the conversation and try again.",
    );
  }
  const support = sessionActionSupport(input.capabilities, input.action);
  if (!support) return unavailable("unsupported", "This action is not available.");
  return support.supported ? undefined : support.unavailableReason;
}

/**
 * Projection merge for a `thread.session.set`. Omitted keeps the current
 * snapshot and null clears it. Snapshots are dispatched from more than one
 * place (session start, discovery refresh), so one taken earlier never
 * replaces a newer one: an older generation, or the same generation checked
 * earlier, keeps the current snapshot.
 */
export function mergeSessionCapabilities(
  current: ProviderSessionCapabilities | null | undefined,
  incoming: ProviderSessionCapabilities | null | undefined,
): ProviderSessionCapabilities | null | undefined {
  if (incoming === undefined) return current;
  if (incoming === null || !current) return incoming;
  if (incoming.generation < current.generation) return current;
  if (incoming.generation === current.generation && incoming.checkedAt < current.checkedAt)
    return current;
  return incoming;
}

const SESSION_GENERATION_KEY = "sessionGeneration";

/** Generation persisted in the binding's runtime payload; 0 before Release 2. */
export function readPersistedSessionGeneration(runtimePayload: unknown): number {
  if (!isRecord(runtimePayload)) return 0;
  const value = runtimePayload[SESSION_GENERATION_KEY];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

export function sessionGenerationPayload(generation: number): Record<string, number> {
  return { [SESSION_GENERATION_KEY]: generation };
}
