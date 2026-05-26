import type { ServerProvider } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

export interface ProviderAdvisoryProjectionShape {
  readonly getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;
  readonly streamChanges: Stream.Stream<ReadonlyArray<ServerProvider>>;
}

export class ProviderAdvisoryProjection extends ServiceMap.Service<
  ProviderAdvisoryProjection,
  ProviderAdvisoryProjectionShape
>()("t3/provider/Services/ProviderAdvisoryProjection") {}
