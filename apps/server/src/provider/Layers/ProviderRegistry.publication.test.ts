import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { Deferred, Effect, Fiber, Layer, PubSub, Ref, Stream } from "effect";
import { expect } from "vitest";
import { ServerConfig } from "../../config";
import type { ProviderInstance } from "../ProviderDriver";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry";
import { ProviderRegistry } from "../Services/ProviderRegistry";
import { ProviderRegistryLive } from "./ProviderRegistry";

const infra = ServerConfig.layerTest(process.cwd(), { prefix: "catalog-publication-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

it.effect("ignores a retired instance's late probe result or failure", () =>
  Effect.gen(function* () {
    for (const fails of [false, true]) {
      const id = ProviderInstanceId.make("codex");
      const driver = ProviderDriverKind.make("codex");
      const snapshot: ServerProvider = {
        instanceId: id,
        driver,
        enabled: true,
        installed: true,
        version: "new",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-11-01T00:00:00Z",
        models: [],
        skills: [],
        slashCommands: [],
      };
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let probing = false;
      const makeInstance = (retired: boolean): ProviderInstance => ({
        instanceId: id,
        driverKind: driver,
        displayName: undefined,
        enabled: true,
        continuationIdentity: { driverKind: driver, continuationKey: "test" },
        snapshot: {
          getSnapshot: Effect.succeed(retired ? { ...snapshot, version: "old" } : snapshot),
          refresh: Effect.gen(function* () {
            if (retired && probing) {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              if (fails) return yield* Effect.die("retired failure");
            }
            return snapshot;
          }),
          streamChanges: Stream.empty,
        },
        adapter: {} as ProviderInstance["adapter"],
        textGeneration: {} as ProviderInstance["textGeneration"],
      });
      const old = makeInstance(true);
      const current = yield* Ref.make(old);
      const changes = yield* PubSub.unbounded<void>();
      yield* Effect.gen(function* () {
        const registry = yield* ProviderRegistry;
        probing = true;
        const refresh = yield* registry.refreshInstance(id).pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        const published = yield* Stream.toPull(
          registry.streamChanges.pipe(
            Stream.filter((providers) => providers[0]?.version === "new"),
          ),
        );
        yield* Ref.set(current, makeInstance(false));
        yield* PubSub.publish(changes, undefined);
        yield* published;
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.join(refresh))[0]?.version).toBe("new");
        expect((yield* registry.getProviders)[0]?.version).toBe("new");
      }).pipe(
        Effect.provide(ProviderRegistryLive),
        Effect.provideService(ProviderInstanceRegistry, {
          getInstance: () => Ref.get(current),
          listInstances: Ref.get(current).pipe(Effect.map((instance) => [instance])),
          listUnavailable: Effect.succeed([]),
          streamChanges: Stream.fromPubSub(changes),
          subscribeChanges: PubSub.subscribe(changes),
        }),
        Effect.scoped,
      );
    }
  }).pipe(Effect.provide(infra)),
);

it.live("publishes merged models in order and refreshes rebuilt instances once", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const id = ProviderInstanceId.make("claudeAgent");
      const driver = ProviderDriverKind.make("claudeAgent");
      const model = {
        slug: "claude-sonnet-5-5",
        name: "Sonnet",
        isCustom: false,
        isUnlisted: false,
        capabilities: { source: "reported" as const, supportsFastMode: true },
      };
      const initial: ServerProvider = {
        instanceId: id,
        driver,
        configurationFingerprint: "first",
        enabled: true,
        installed: true,
        version: "2.1.298",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-10-16T00:00:00.000Z",
        modelCatalog: { status: "menu", lastSuccessAt: "2026-10-16T00:00:00.000Z" },
        models: [model],
        slashCommands: [],
        skills: [],
      };
      const raw = yield* Ref.make(initial);
      const updates: Array<ServerProvider["models"]> = [];
      const rebuiltReady = yield* Deferred.make<void>();
      let firstRefreshes = 0;
      let rebuiltRefreshes = 0;
      const makeInstance = (rebuilt: boolean): ProviderInstance => ({
        instanceId: id,
        driverKind: driver,
        continuationIdentity: { driverKind: driver, continuationKey: "test" },
        displayName: undefined,
        enabled: true,
        configurationFingerprint: rebuilt ? "second" : "first",
        snapshot: {
          getSnapshot: Ref.get(raw),
          refresh: Effect.sync(() => {
            if (rebuilt) rebuiltRefreshes++;
            else firstRefreshes++;
          }).pipe(Effect.andThen(Ref.get(raw))),
          streamChanges: Stream.empty,
        },
        adapter: {} as ProviderInstance["adapter"],
        textGeneration: {} as ProviderInstance["textGeneration"],
        updateModelCatalog: (models) =>
          Effect.sync(() => updates.push(models)).pipe(
            Effect.andThen(rebuilt ? Deferred.succeed(rebuiltReady, undefined) : Effect.void),
            Effect.asVoid,
          ),
      });
      const instances = yield* Ref.make<ReadonlyArray<ProviderInstance>>([makeInstance(false)]);
      const changes = yield* Effect.acquireRelease(PubSub.unbounded<void>(), PubSub.shutdown);
      yield* Effect.gen(function* () {
        const registry = yield* ProviderRegistry;
        expect(firstRefreshes).toBe(1);
        yield* Ref.set(raw, {
          ...initial,
          checkedAt: "2026-10-16T01:00:00.000Z",
          modelCatalog: { status: "failed" },
          models: [{ ...model, isUnlisted: true, capabilities: { source: "built-in" } }],
        });
        const published = yield* registry.streamChanges.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true }),
        );
        const failed = yield* registry.refreshInstance(id);
        expect((yield* Fiber.join(published))[0]).toEqual(failed);
        expect(failed[0]?.models).toEqual([model]);
        expect(failed[0]?.probeOutcome).toBe("success");
        expect(updates).toEqual([[model], [model]]);
        yield* Ref.set(raw, {
          ...initial,
          configurationFingerprint: "second",
          models: [],
          modelCatalog: { status: "failed" },
        });
        yield* Ref.set(instances, [makeInstance(true)]);
        yield* PubSub.publish(changes, undefined);
        yield* Deferred.await(rebuiltReady);
        expect(rebuiltRefreshes).toBe(1);
        expect(updates.at(-1)).toEqual([]);
      }).pipe(
        Effect.provide(ProviderRegistryLive),
        Effect.provideService(ProviderInstanceRegistry, {
          getInstance: (instanceId) =>
            Ref.get(instances).pipe(
              Effect.map((values) => values.find((instance) => instance.instanceId === instanceId)),
            ),
          listInstances: Ref.get(instances),
          listUnavailable: Effect.succeed([]),
          streamChanges: Stream.fromPubSub(changes),
          subscribeChanges: PubSub.subscribe(changes),
        }),
      );
    }).pipe(Effect.provide(infra)),
  ),
);

it.effect("stamps fresh probe evidence for an arbitrary driver's snapshots", () =>
  Effect.gen(function* () {
    const id = ProviderInstanceId.make("custom-instance");
    const driver = ProviderDriverKind.make("custom-driver");
    const raw = yield* Ref.make<ServerProvider>({
      instanceId: id,
      driver,
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "unknown" },
      checkedAt: "2026-10-17T00:00:00Z",
      models: [],
      skills: [],
      slashCommands: [],
    });
    const instance: ProviderInstance = {
      instanceId: id,
      driverKind: driver,
      displayName: undefined,
      enabled: true,
      continuationIdentity: { driverKind: driver, continuationKey: "test" },
      snapshot: {
        getSnapshot: Ref.get(raw),
        // Model enrichment finishes before the older probe returns.
        refresh: Ref.get(raw).pipe(
          Effect.tap(() =>
            Ref.update(raw, (snapshot) => ({
              ...snapshot,
              auth: { status: "authenticated" as const },
            })),
          ),
        ),
        streamChanges: Stream.empty,
      },
      adapter: {} as ProviderInstance["adapter"],
      textGeneration: {} as ProviderInstance["textGeneration"],
    };
    yield* Effect.gen(function* () {
      const registry = yield* ProviderRegistry;
      const first = (yield* registry.getProviders)[0]!;
      expect(first.auth.status).toBe("authenticated");
      expect(first.probeOutcome).toBe("success");
      expect(first.probeOutcomeStartedAt).toBe(first.checkedAt);
      yield* Ref.update(raw, (snapshot) => ({
        ...snapshot,
        status: "error" as const,
        checkedAt: "2026-10-17T00:01:00Z",
      }));
      const second = (yield* registry.refreshInstance(id))[0]!;
      expect(second.probeOutcome).toBe("transient_failure");
      expect(second.probeOutcomeStartedAt).toBe(second.checkedAt);
      yield* Ref.update(raw, (snapshot) => ({ ...snapshot, checkedAt: "2026-10-17T00:02:00Z" }));
      const third = (yield* registry.refreshInstance(id))[0]!;
      expect(third.probeOutcomeStartedAt).toBe(second.probeOutcomeStartedAt);
    }).pipe(
      Effect.provide(ProviderRegistryLive),
      Effect.provideService(ProviderInstanceRegistry, {
        listInstances: Effect.succeed([instance]),
        getInstance: () => Effect.succeed(instance),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.acquireRelease(PubSub.unbounded<void>(), PubSub.shutdown).pipe(
          Effect.flatMap(PubSub.subscribe),
        ),
      }),
    );
  }).pipe(Effect.provide(infra)),
);
