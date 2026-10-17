import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { Deferred, Effect, Layer, PubSub, Ref, Stream } from "effect";
import { expect } from "vitest";
import { ServerConfig } from "../../config";
import type { ProviderInstance } from "../ProviderDriver";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry";
import { ProviderRegistry } from "../Services/ProviderRegistry";
import { ProviderRegistryLive } from "./ProviderRegistry";

const infra = ServerConfig.layerTest(process.cwd(), { prefix: "catalog-publication-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

it.live(
  "publishes merged models in order and refreshes rebuilt instances once without reading their raw snapshots",
  () =>
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
            getSnapshot: Effect.die("raw getSnapshot must not be called"),
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
          const failed = yield* registry.refreshInstance(id);
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
                Effect.map((values) =>
                  values.find((instance) => instance.instanceId === instanceId),
                ),
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
