import type { PrHubRefreshContext, createPrHubRefresh } from "../coordination.ts";
import { ServiceMap, type Effect } from "effect";
import type { PrHubRefreshInput, PrHubSnapshot } from "@t3tools/contracts";

export type PrHubRefresh = (input: PrHubRefreshInput) => Effect.Effect<PrHubSnapshot>;
export class PrHubJobCoordinator extends ServiceMap.Service<
  PrHubJobCoordinator,
  {
    readonly createWorkflow: (
      context: PrHubRefreshContext,
    ) => ReturnType<typeof createPrHubRefresh>;
    readonly createRefresh: (run: PrHubRefresh) => Effect.Effect<PrHubRefresh>;
    readonly startMonitoring: (refresh: PrHubRefresh) => Effect.Effect<void>;
  }
>()("t3/prHub/Services/PrHubJobCoordinator") {}
