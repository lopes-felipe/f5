import {
  defaultInstanceIdForDriver,
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  type ProviderKind,
} from "@t3tools/contracts";
import { Effect, PubSub, Stream } from "effect";

import { ProviderUnsupportedError, type ProviderAdapterError } from "../Errors.ts";
import { defaultProviderContinuationIdentity } from "../ProviderDriver.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { ProviderAdapterRegistryShape } from "../Services/ProviderAdapterRegistry.ts";

export type KindAdapterMap = Partial<
  Record<ProviderKind, ProviderAdapterShape<ProviderAdapterError>>
>;

export const makeAdapterRegistryMock = (
  adapters: KindAdapterMap,
): ProviderAdapterRegistryShape => ({
  getByInstance: (instanceId) => {
    const adapter = adapters[instanceId as ProviderKind];
    return adapter
      ? Effect.succeed(adapter)
      : Effect.fail(new ProviderUnsupportedError({ provider: instanceId }));
  },
  getInstanceInfo: (instanceId) => {
    const adapter = adapters[instanceId as ProviderKind];
    if (!adapter) {
      return Effect.fail(new ProviderUnsupportedError({ provider: instanceId }));
    }
    const driverKind = ProviderDriverKind.make(adapter.provider);
    return Effect.succeed({
      instanceId,
      driverKind,
      displayName: PROVIDER_DISPLAY_NAMES[adapter.provider],
      enabled: true,
      continuationIdentity: defaultProviderContinuationIdentity({ driverKind, instanceId }),
    });
  },
  listInstances: () =>
    Effect.succeed(
      Object.keys(adapters)
        .filter((provider): provider is ProviderKind => Boolean(adapters[provider as ProviderKind]))
        .map((provider) => defaultInstanceIdForDriver(ProviderDriverKind.make(provider))),
    ),
  getByProvider: (provider) => {
    const adapter = adapters[provider];
    return adapter
      ? Effect.succeed(adapter)
      : Effect.fail(new ProviderUnsupportedError({ provider }));
  },
  listProviders: () =>
    Effect.succeed(
      Object.keys(adapters).filter((provider): provider is ProviderKind =>
        Boolean(adapters[provider as ProviderKind]),
      ),
    ),
  streamChanges: Stream.empty,
  subscribeChanges: Effect.acquireRelease(PubSub.unbounded<void>(), PubSub.shutdown).pipe(
    Effect.flatMap(PubSub.subscribe),
  ),
});
