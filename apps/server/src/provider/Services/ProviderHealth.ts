/**
 * ProviderHealth - Provider readiness snapshot service.
 *
 * Owns provider health checks (install/auth reachability) and exposes a
 * short-lived cached snapshot to transport layers.
 *
 * @module ProviderHealth
 */
import type { ServerProviderStatus } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

export interface ProviderHealthShape {
  /**
   * Read provider health statuses from the current cached snapshot.
   */
  readonly getStatuses: Effect.Effect<ReadonlyArray<ServerProviderStatus>>;
}

export class ProviderHealth extends ServiceMap.Service<ProviderHealth, ProviderHealthShape>()(
  "t3/provider/Services/ProviderHealth",
) {}
