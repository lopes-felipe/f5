import type { ServerProvider } from "@t3tools/contracts";
import { Effect, Layer, Stream } from "effect";

import {
  ProviderAdvisoryProjection,
  type ProviderAdvisoryProjectionShape,
} from "../Services/ProviderAdvisoryProjection.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { ProviderUpdateAdvisor } from "../Services/ProviderUpdateAdvisor.ts";
import { isBuiltInProviderDriver } from "../providerUpdateLookup.ts";

export const ProviderAdvisoryProjectionLive = Layer.effect(
  ProviderAdvisoryProjection,
  Effect.gen(function* () {
    const providerRegistry = yield* ProviderRegistry;
    const providerUpdateAdvisor = yield* ProviderUpdateAdvisor;

    const decorateProvider = (provider: ServerProvider): Effect.Effect<ServerProvider> => {
      if (!isBuiltInProviderDriver(provider.driver)) {
        return Effect.succeed(provider);
      }
      return providerUpdateAdvisor
        .getAdvisoryFor({
          instanceId: provider.instanceId,
          driver: provider.driver,
          currentVersion: provider.version,
        })
        .pipe(
          Effect.map((versionAdvisory) =>
            versionAdvisory.status === "unknown" ? provider : { ...provider, versionAdvisory },
          ),
        );
    };

    const decorateProviders = (providers: ReadonlyArray<ServerProvider>) =>
      Effect.forEach(providers, decorateProvider, { concurrency: "unbounded" });

    return {
      getProviders: providerRegistry.getProviders.pipe(Effect.flatMap(decorateProviders)),
      get streamChanges() {
        return providerRegistry.streamChanges.pipe(Stream.mapEffect(decorateProviders));
      },
    } satisfies ProviderAdvisoryProjectionShape;
  }),
);
