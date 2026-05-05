/**
 * ProviderAdapterRegistry - Lookup boundary for provider adapter implementations.
 *
 * Maps a provider instance id to the concrete adapter service (Codex, Claude, etc).
 * It does not own session lifecycle or routing rules; `ProviderService` uses
 * this registry together with `ProviderSessionDirectory`.
 *
 * @module ProviderAdapterRegistry
 */
import type { ProviderDriverKind, ProviderInstanceId, ProviderKind } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect, PubSub, Scope, Stream } from "effect";

import type { ProviderAdapterError, ProviderUnsupportedError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";
import type { ProviderContinuationIdentity } from "../ProviderDriver.ts";

export interface ProviderInstanceRoutingInfo {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string | undefined;
  readonly accentColor?: string | undefined;
  readonly enabled: boolean;
  readonly continuationIdentity: ProviderContinuationIdentity;
}

/**
 * ProviderAdapterRegistryShape - Service API for adapter lookup by provider kind.
 */
export interface ProviderAdapterRegistryShape {
  /**
   * Resolve the adapter for a specific configured provider instance.
   */
  readonly getByInstance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderAdapterShape<ProviderAdapterError>, ProviderUnsupportedError>;

  readonly getInstanceInfo: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderInstanceRoutingInfo, ProviderUnsupportedError>;

  readonly listInstances: () => Effect.Effect<ReadonlyArray<ProviderInstanceId>>;

  /**
   * Legacy shim: resolve the default instance for a provider kind.
   *
   * @deprecated Prefer `getByInstance`. This intentionally keeps old callers on
   * the default instance and is not multi-instance aware.
   */
  readonly getByProvider: (
    provider: ProviderKind,
  ) => Effect.Effect<ProviderAdapterShape<ProviderAdapterError>, ProviderUnsupportedError>;

  /**
   * List provider kinds currently registered.
   */
  readonly listProviders: () => Effect.Effect<ReadonlyArray<ProviderKind>>;

  readonly streamChanges: Stream.Stream<void>;

  readonly subscribeChanges: Effect.Effect<PubSub.Subscription<void>, never, Scope.Scope>;
}

/**
 * ProviderAdapterRegistry - Service tag for provider adapter lookup.
 */
export class ProviderAdapterRegistry extends ServiceMap.Service<
  ProviderAdapterRegistry,
  ProviderAdapterRegistryShape
>()("t3/provider/Services/ProviderAdapterRegistry") {}

// Dummy comment for workflow testing.
