/**
 * ProviderAdapterRegistryLive — facade over ProviderInstanceRegistry.
 *
 * Adapter construction now happens inside ProviderDriver.create(). This layer
 * performs dynamic lookups against the live instance registry so settings
 * changes and custom instances are visible without rebuilding the server layer.
 */
import {
  defaultInstanceIdForDriver,
  type ProviderKind,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { Effect, Layer } from "effect";

import { ProviderUnsupportedError } from "../Errors.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import {
  ProviderAdapterRegistry,
  type ProviderAdapterRegistryShape,
} from "../Services/ProviderAdapterRegistry.ts";

const makeProviderAdapterRegistry = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry;

  const getByInstance: ProviderAdapterRegistryShape["getByInstance"] = (instanceId) =>
    registry
      .getInstance(instanceId)
      .pipe(
        Effect.flatMap((instance) =>
          instance
            ? Effect.succeed(instance.adapter)
            : Effect.fail(new ProviderUnsupportedError({ provider: instanceId })),
        ),
      );

  const getInstanceInfo: ProviderAdapterRegistryShape["getInstanceInfo"] = (instanceId) =>
    registry.getInstance(instanceId).pipe(
      Effect.flatMap((instance) =>
        instance
          ? Effect.succeed({
              instanceId: instance.instanceId,
              driverKind: instance.driverKind,
              displayName: instance.displayName,
              accentColor: instance.accentColor,
              enabled: instance.enabled,
              continuationIdentity: instance.continuationIdentity,
            })
          : Effect.fail(new ProviderUnsupportedError({ provider: instanceId })),
      ),
    );

  const listInstances: ProviderAdapterRegistryShape["listInstances"] = () =>
    registry.listInstances.pipe(
      Effect.map((instances) => instances.map((instance) => instance.instanceId)),
    );

  const getByProvider: ProviderAdapterRegistryShape["getByProvider"] = (provider) =>
    getByInstance(defaultInstanceIdForDriver(provider as ProviderDriverKind));

  const listProviders: ProviderAdapterRegistryShape["listProviders"] = () =>
    registry.listInstances.pipe(
      Effect.map((instances) => {
        const providers = new Set<ProviderKind>();
        for (const instance of instances) {
          if (instance.instanceId === defaultInstanceIdForDriver(instance.driverKind)) {
            providers.add(instance.driverKind as ProviderKind);
          }
        }
        return Array.from(providers);
      }),
    );

  return {
    getByInstance,
    getInstanceInfo,
    listInstances,
    getByProvider,
    listProviders,
    streamChanges: registry.streamChanges,
    subscribeChanges: registry.subscribeChanges,
  } satisfies ProviderAdapterRegistryShape;
});

export const ProviderAdapterRegistryLive = Layer.effect(
  ProviderAdapterRegistry,
  makeProviderAdapterRegistry,
);

export { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
export { ProviderInstanceId };
