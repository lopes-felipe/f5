import { ProviderNativeHistory } from "../ProviderNativeHistory.ts";
import { PiSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { Duration, Effect, FileSystem, Option, Path, Schema, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ServerConfig } from "../../config.ts";
import { makePiTextGeneration } from "../../git/Layers/PiTextGeneration.ts";
import { PreviewMcpHttpServer } from "../../mcp/PreviewMcpHttpServer.ts";
import { acquireAccountAdmission } from "../../profiles/ProviderAccountGuard.ts";
import { buildAccountExecutionEnvironment } from "../../providerProcessEnv.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makePiAdapter } from "../Layers/PiAdapter.ts";
import {
  buildInitialPiProviderSnapshot,
  checkPiProviderStatus,
  piModelsFromSettings,
} from "../Layers/PiProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { ProviderContinuationRequests } from "../ProviderContinuationRequests.ts";
import { makeOwnedOperation } from "../ownedOperation.ts";
import type { PiCatalog } from "../pi/PiMetadata.ts";
import { PiRpcError } from "../pi/PiRpc.ts";
import { defaultProviderContinuationIdentity, type ProviderDriver } from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";

const driverKind = ProviderDriverKind.make("pi");
export type PiDriverEnv =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | ServerConfig;

/** Explicit instances only: no migration adds a Pi process to an existing installation. */
export const PiDriver: ProviderDriver<PiSettings, PiDriverEnv> = {
  driverKind,
  metadata: { displayName: "Pi", supportsMultipleInstances: true },
  configSchema: PiSettings,
  defaultConfig: () => Schema.decodeSync(PiSettings)({}),
  create: ({ instanceId, displayName, accentColor, enabled, config, environment }) =>
    Effect.gen(function* () {
      const server = yield* ServerConfig;
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = yield* Effect.scope;
      const own = yield* makeOwnedOperation(
        root,
        () =>
          new PiRpcError({ operation: "instance", detail: "This Pi instance has been replaced." }),
      );
      const processEnv = buildAccountExecutionEnvironment({
        purpose: "provider",
        profile: server.profile,
        stateDir: server.stateDir,
        baseEnv: process.env,
        instance: environment,
      });
      const settings = { ...config, enabled };
      const beforeLaunch = Effect.acquireRelease(
        Effect.try({
          try: () => acquireAccountAdmission(server.stateDir, instanceId),
          catch: () =>
            new PiRpcError({
              operation: "account",
              detail: "Account setup is in progress. Retry after setup finishes.",
            }),
        }),
        (release) => Effect.sync(release),
      ).pipe(Effect.asVoid);
      const continuationIdentity = defaultProviderContinuationIdentity({ driverKind, instanceId });
      const stamp = (snapshot: ServerProviderDraft): ServerProvider => ({
        ...snapshot,
        instanceId,
        driver: driverKind,
        ...(displayName ? { displayName } : {}),
        ...(accentColor ? { accentColor } : {}),
        continuation: { groupKey: continuationIdentity.continuationKey },
      });
      const continuations = Option.getOrUndefined(
        yield* Effect.serviceOption(ProviderContinuationRequests),
      );
      const nativeHistory = Option.getOrUndefined(
        yield* Effect.serviceOption(ProviderNativeHistory),
      );
      const preview = Option.getOrUndefined(yield* Effect.serviceOption(PreviewMcpHttpServer));
      let liveCatalog: PiCatalog | undefined;
      let baseSnapshot = buildInitialPiProviderSnapshot(settings);
      let refreshSnapshot: Effect.Effect<void> = Effect.void;
      const adapter = yield* makePiAdapter(settings, {
        instanceId,
        environment: processEnv,
        cacheDir: path.join(server.stateDir, "provider-extensions", "pi"),
        beforeLaunch,
        ...(continuations ? { offerContinuation: continuations.offer } : {}),
        ...(nativeHistory ? { reconcileNativeHistory: nativeHistory.reconcile } : {}),
        onCatalog: (catalog) =>
          Effect.gen(function* () {
            liveCatalog = catalog;
            yield* refreshSnapshot;
          }),
        ...(preview?.supportsThreadCatalog
          ? {
              createMcpSession: (threadId: import("@t3tools/contracts").ThreadId) =>
                Effect.acquireRelease(
                  Effect.try({
                    try: () =>
                      preview.createSessionConfig({
                        threadId,
                        providerInstanceId: instanceId,
                        catalog: "thread",
                      }),
                    catch: () =>
                      new PiRpcError({
                        operation: "mcp",
                        detail: "The F5 thread catalog could not be created.",
                      }),
                  }),
                  (session) => Effect.sync(session.dispose),
                ).pipe(
                  Effect.flatMap((session) => {
                    const definition = session.serverDefinition;
                    if (
                      definition.type !== "http" ||
                      !definition.bearerTokenEnvVar ||
                      !session.env[definition.bearerTokenEnvVar]
                    )
                      return Effect.fail(
                        new PiRpcError({
                          operation: "mcp",
                          detail: "The F5 thread catalog did not provide scoped credentials.",
                        }),
                      );
                    return Effect.succeed({
                      endpoint: definition.url,
                      authorizationHeader: `Bearer ${session.env[definition.bearerTokenEnvVar]}`,
                    });
                  }),
                ),
            }
          : {}),
      });
      const textGeneration = yield* makePiTextGeneration(settings, processEnv, beforeLaunch, own);
      const snapshot = yield* makeManagedServerProvider<PiSettings>({
        getSettings: Effect.succeed(settings),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (initial) => stamp(buildInitialPiProviderSnapshot(initial)),
        checkProvider: Effect.suspend(() =>
          liveCatalog
            ? Effect.succeed({
                ...baseSnapshot,
                installed: true,
                status: "ready" as const,
                models: piModelsFromSettings(settings, liveCatalog.models),
                slashCommands: liveCatalog.slashCommands,
                skills: liveCatalog.skills,
                message: "Pi's workspace catalog is available; credentials remain managed by Pi.",
              })
            : own(checkPiProviderStatus(settings, processEnv, beforeLaunch)).pipe(
                Effect.orElseSucceed(() => buildInitialPiProviderSnapshot(settings)),
                Effect.tap((checked) =>
                  Effect.sync(() => {
                    baseSnapshot = checked;
                  }),
                ),
              ),
        ).pipe(
          Effect.map(stamp),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fs),
        ),
        refreshInterval: Duration.minutes(5),
      }).pipe(
        Effect.mapError(
          () =>
            new ProviderDriverError({
              driver: driverKind,
              instanceId,
              detail: "Pi status could not be initialized.",
            }),
        ),
      );
      refreshSnapshot = snapshot.refresh.pipe(Effect.asVoid);
      return {
        instanceId,
        driverKind,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      };
    }).pipe(
      Effect.mapError(
        () =>
          new ProviderDriverError({
            driver: driverKind,
            instanceId,
            detail: "The Pi instance could not be initialized.",
          }),
      ),
    ),
};
