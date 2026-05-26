import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderAdvisoryEntry,
  type ServerProviderUpdateCommand,
  type ServerProviderVersionAdvisory,
} from "@t3tools/contracts";
import { Duration, Effect, Fiber, Layer, PubSub, Ref, Stream } from "effect";

import { compareCliVersions, normalizeCliVersion } from "../cliVersion.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import {
  ProviderUpdateAdvisor,
  type ProviderUpdateAdvisorShape,
} from "../Services/ProviderUpdateAdvisor.ts";
import {
  getProviderUpdateSource,
  isBuiltInProviderDriver,
  lookupLatestVersionForDriver,
  makeUnknownProviderVersionAdvisory,
  type LatestVersionLookupFailure,
} from "../providerUpdateLookup.ts";
import { HttpClient } from "effect/unstable/http";

const SUCCESS_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const NETWORK_RETRY_MS = 30 * 60 * 1000;
const RATE_LIMIT_BASE_RETRY_MS = 30 * 60 * 1000;
const RATE_LIMIT_MAX_RETRY_MS = 24 * 60 * 60 * 1000;
const NOT_FOUND_RETRY_MS = 24 * 60 * 60 * 1000;
const PARSE_RETRY_MS = 6 * 60 * 60 * 1000;
const REGISTRY_CHANGE_DEBOUNCE = Duration.seconds(5);

interface DriverCacheEntry {
  readonly latestVersion: string | null;
  readonly updateCommand: ServerProviderUpdateCommand | null;
  readonly fetchedAtMs: number;
  readonly nextEligibleAtMs: number;
  readonly consecutiveFailures: number;
  readonly lastFailureTag: LatestVersionLookupFailure["_tag"] | null;
}

function formatVersionLabel(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

function normalizeForCompare(version: string): string {
  return normalizeCliVersion(version.replace(/^v/i, ""));
}

function buildAdvisoryFromCache(input: {
  readonly driver: ProviderDriverKind;
  readonly currentVersion: string | null;
  readonly cacheEntry: DriverCacheEntry | undefined;
}): ServerProviderVersionAdvisory {
  const checkedAt = input.cacheEntry ? new Date(input.cacheEntry.fetchedAtMs).toISOString() : null;

  if (!isBuiltInProviderDriver(input.driver)) {
    return makeUnknownProviderVersionAdvisory({
      currentVersion: input.currentVersion,
      checkedAt,
    });
  }

  if (input.driver === "cursor") {
    return makeUnknownProviderVersionAdvisory({
      currentVersion: input.currentVersion,
      checkedAt,
      message: "Cursor Agent latest-version checks are not available.",
    });
  }

  const latestVersion = input.cacheEntry?.latestVersion ?? null;
  const updateCommand = input.cacheEntry?.updateCommand ?? null;
  if (!input.currentVersion || !latestVersion || !updateCommand) {
    return makeUnknownProviderVersionAdvisory({
      currentVersion: input.currentVersion,
      checkedAt,
      message: input.cacheEntry?.lastFailureTag
        ? "Could not check the latest provider version."
        : null,
    });
  }

  const comparison = compareCliVersions(
    normalizeForCompare(input.currentVersion),
    normalizeForCompare(latestVersion),
  );
  if (comparison >= 0) {
    return {
      status: "current",
      currentVersion: input.currentVersion,
      latestVersion,
      updateCommand: null,
      checkedAt,
      message: null,
    };
  }

  return {
    status: "behind_latest",
    currentVersion: input.currentVersion,
    latestVersion,
    updateCommand,
    checkedAt,
    message: `Installed ${formatVersionLabel(input.currentVersion)} · latest ${formatVersionLabel(
      latestVersion,
    )}`,
  };
}

export function failureRetryDelayMs(
  failure: LatestVersionLookupFailure,
  consecutiveFailuresBefore: number,
): number {
  switch (failure._tag) {
    case "rate_limited": {
      const exponential = Math.min(
        RATE_LIMIT_MAX_RETRY_MS,
        RATE_LIMIT_BASE_RETRY_MS * 2 ** Math.min(consecutiveFailuresBefore, 8),
      );
      return Math.max(exponential, failure.retryAfterMs ?? 0);
    }
    case "network":
      return NETWORK_RETRY_MS;
    case "not_found":
      return NOT_FOUND_RETRY_MS;
    case "parse":
      return PARSE_RETRY_MS;
  }
}

function shouldRefreshDriver(input: {
  readonly entry: DriverCacheEntry | undefined;
  readonly nowMs: number;
  readonly force: boolean;
}): boolean {
  if (!input.entry) return true;
  if (input.nowMs >= input.entry.nextEligibleAtMs) return true;
  return input.force && input.entry.lastFailureTag === null;
}

export function hasAdvisoryStateChanged(
  previous: ServerProviderVersionAdvisory | undefined,
  next: ServerProviderVersionAdvisory,
): boolean {
  if (!previous) return true;
  return (
    previous.status !== next.status ||
    previous.currentVersion !== next.currentVersion ||
    previous.latestVersion !== next.latestVersion
  );
}

const shouldPublishAdvisory = (advisory: ServerProviderVersionAdvisory): boolean =>
  advisory.status !== "unknown";

function advisoryEligibleProviders(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> {
  return providers.filter((provider) => isBuiltInProviderDriver(provider.driver));
}

export const ProviderUpdateAdvisorLive = Layer.effect(
  ProviderUpdateAdvisor,
  Effect.gen(function* () {
    const providerRegistry = yield* ProviderRegistry;
    const httpClient = yield* HttpClient.HttpClient;
    const driverCacheRef = yield* Ref.make<ReadonlyMap<ProviderDriverKind, DriverCacheEntry>>(
      new Map(),
    );
    const lastPublishedRef = yield* Ref.make<
      ReadonlyMap<ProviderInstanceId, ServerProviderVersionAdvisory>
    >(new Map());
    const inFlightRef = yield* Ref.make(false);
    const debounceFiberRef = yield* Ref.make<Fiber.Fiber<void, unknown> | null>(null);
    const scope = yield* Effect.scope;
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<ReadonlyArray<ServerProviderAdvisoryEntry>>(),
      PubSub.shutdown,
    );

    const getAdvisoryFor: ProviderUpdateAdvisorShape["getAdvisoryFor"] = (input) =>
      Ref.get(driverCacheRef).pipe(
        Effect.map((cache) =>
          buildAdvisoryFromCache({
            driver: input.driver,
            currentVersion: input.currentVersion,
            cacheEntry: cache.get(input.driver),
          }),
        ),
      );

    const reconcileAndPublish = Effect.fn("reconcileProviderUpdateAdvisories")(function* () {
      const providers = advisoryEligibleProviders(yield* providerRegistry.getProviders);
      const entries = yield* Effect.forEach(
        providers,
        (provider) =>
          getAdvisoryFor({
            instanceId: provider.instanceId,
            driver: provider.driver,
            currentVersion: provider.version,
          }).pipe(
            Effect.map(
              (versionAdvisory) =>
                ({
                  instanceId: provider.instanceId,
                  driver: provider.driver,
                  versionAdvisory,
                }) satisfies ServerProviderAdvisoryEntry,
            ),
          ),
        { concurrency: "unbounded" },
      );

      const publishableEntries = entries.filter((entry) =>
        shouldPublishAdvisory(entry.versionAdvisory),
      );
      const nextByInstance = new Map(
        publishableEntries.map((entry) => [entry.instanceId, entry.versionAdvisory] as const),
      );
      const previousByInstance = yield* Ref.get(lastPublishedRef);
      const changed =
        previousByInstance.size !== nextByInstance.size ||
        publishableEntries.some((entry) =>
          hasAdvisoryStateChanged(previousByInstance.get(entry.instanceId), entry.versionAdvisory),
        ) ||
        [...previousByInstance.keys()].some((instanceId) => !nextByInstance.has(instanceId));

      if (!changed) return;
      yield* Ref.set(lastPublishedRef, nextByInstance);
      yield* PubSub.publish(changesPubSub, publishableEntries).pipe(Effect.asVoid);
    });

    const refreshDriver = Effect.fn("refreshProviderUpdateDriver")(function* (
      driver: ProviderDriverKind,
      force: boolean,
    ) {
      const source = getProviderUpdateSource(driver);
      if (!source) return;

      const nowMs = Date.now();
      const entry = (yield* Ref.get(driverCacheRef)).get(driver);
      if (!shouldRefreshDriver({ entry, nowMs, force })) {
        return;
      }

      const result = yield* lookupLatestVersionForDriver(driver).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
      if (result === null) return;

      if (result._tag === "success") {
        yield* Ref.update(driverCacheRef, (cache) => {
          const next = new Map(cache);
          next.set(driver, {
            latestVersion: result.latestVersion,
            updateCommand: result.updateCommand,
            fetchedAtMs: nowMs,
            nextEligibleAtMs: nowMs + SUCCESS_REFRESH_INTERVAL_MS,
            consecutiveFailures: 0,
            lastFailureTag: null,
          });
          return next;
        });
        return;
      }

      const consecutiveFailures = (entry?.consecutiveFailures ?? 0) + 1;
      const retryDelayMs = failureRetryDelayMs(result.failure, entry?.consecutiveFailures ?? 0);
      yield* Effect.logWarning("provider latest-version lookup failed", {
        driver,
        packageName: source.packageName,
        failure: result.failure._tag,
        retryDelayMs,
      });
      yield* Ref.update(driverCacheRef, (cache) => {
        const next = new Map(cache);
        next.set(driver, {
          latestVersion: null,
          updateCommand: null,
          fetchedAtMs: nowMs,
          nextEligibleAtMs: nowMs + retryDelayMs,
          consecutiveFailures,
          lastFailureTag: result.failure._tag,
        });
        return next;
      });
    });

    const refreshAdvisories: ProviderUpdateAdvisorShape["refreshAdvisories"] = (opts) =>
      Effect.gen(function* () {
        const shouldRun = yield* Ref.modify(inFlightRef, (inFlight) => [!inFlight, true] as const);
        if (!shouldRun) return;
        yield* Effect.gen(function* () {
          const providers = advisoryEligibleProviders(yield* providerRegistry.getProviders);
          const drivers = [...new Set(providers.map((provider) => provider.driver))];
          yield* Effect.forEach(drivers, (driver) => refreshDriver(driver, opts?.force === true), {
            concurrency: "unbounded",
            discard: true,
          });
          yield* reconcileAndPublish();
        }).pipe(
          Effect.ensuring(Ref.set(inFlightRef, false)),
          Effect.catchCause((cause) =>
            Effect.logError("provider update advisory refresh failed", { cause }),
          ),
        );
      });

    const noteRegistryChanged = Effect.gen(function* () {
      const previousFiber = yield* Ref.getAndSet(debounceFiberRef, null);
      if (previousFiber) {
        yield* Fiber.interrupt(previousFiber).pipe(Effect.ignore);
      }
      const fiber = yield* Effect.sleep(REGISTRY_CHANGE_DEBOUNCE).pipe(
        Effect.flatMap(() => refreshAdvisories()),
        Effect.ensuring(Ref.set(debounceFiberRef, null)),
        Effect.ignoreCause({ log: true }),
        Effect.forkIn(scope),
      );
      yield* Ref.set(debounceFiberRef, fiber);
    });

    return {
      getAdvisoryFor,
      get streamChanges() {
        return Stream.fromPubSub(changesPubSub);
      },
      noteRegistryChanged,
      refreshAdvisories,
    } satisfies ProviderUpdateAdvisorShape;
  }),
);
