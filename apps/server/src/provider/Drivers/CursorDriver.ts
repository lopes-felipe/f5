import { Option } from "effect";
import { PreviewMcpHttpServer } from "../../mcp/PreviewMcpHttpServer";
import { ComputerAutomationBroker } from "../../computer/ComputerAutomationBroker";
import { makeProviderLimits } from "../../usage/providerLimits.ts";
/**
 * CursorDriver — `ProviderDriver` for the Cursor Agent (`agent`) runtime.
 *
 * Cursor exposes an ACP-based CLI. Status refreshes run only `agent about`,
 * because ACP authentication can open Cursor's browser login flow. The account's
 * model catalog is fetched in the background with `initialize` and
 * `cursor/list_available_models` alone, which never authenticate or open a
 * session (see `cursorModelCatalogCache`).
 *
 * Text generation is supported via the ACP runtime — `makeCursorTextGeneration`
 * drives `runtime.prompt` with a structured-output schema and collects the
 * agent's `agent_message_chunk` stream into a single JSON blob.
 *
 * @module provider/Drivers/CursorDriver
 */
import { CursorSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { Duration, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { makeCursorTextGeneration } from "../../git/Layers/CursorTextGeneration.ts";
import { makeCursorUsageHistory } from "../../usage/externalProviderHistory.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeCursorAdapter } from "../Layers/CursorAdapter.ts";
import {
  buildInitialCursorProviderSnapshot,
  checkCursorProviderStatus,
  fetchCursorModelCatalog,
} from "../Layers/CursorProvider.ts";
import {
  makeCursorModelCatalogCache,
  seedCursorModelCatalog,
} from "../cursor/cursorModelCatalogCache.ts";
import { readProviderStatusCache, resolveProviderStatusCachePath } from "../providerStatusCache.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { cursorScratchDir } from "../cursor/CursorNativeSessions.ts";
import { discoverCursorSkills } from "../acp/CursorSkills.ts";
import { makeInstanceInstallTargetResolver } from "../providerInstallChannel.ts";

const DRIVER_KIND = ProviderDriverKind.make("cursor");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);

export type CursorDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    harnessVariant: "acp",
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const CursorDriver: ProviderDriver<CursorSettings, CursorDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Cursor",
    supportsMultipleInstances: true,
  },
  configSchema: CursorSettings,
  defaultConfig: (): CursorSettings => Schema.decodeSync(CursorSettings)({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      // The registry reports SDK instances unavailable until the host passes
      // the SDK gates. This build ships only the ACP harness, so an SDK
      // config never falls back to ACP.
      if (config.harness === "sdk")
        return yield* new ProviderDriverError({
          driver: DRIVER_KIND,
          instanceId,
          detail: "The Cursor SDK harness is not available in this build.",
        });
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment, process.env);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const usageHistory = yield* makeCursorUsageHistory(processEnv, config.apiEndpoint, enabled);
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies CursorSettings;

      const previewMcp = Option.getOrUndefined(yield* Effect.serviceOption(PreviewMcpHttpServer));
      const computerBroker = Option.getOrUndefined(
        yield* Effect.serviceOption(ComputerAutomationBroker),
      );
      const adapter = yield* makeCursorAdapter(effectiveConfig, {
        environment: processEnv,
        ...(previewMcp ? { previewMcpHttpServer: previewMcp } : {}),
        ...(computerBroker ? { computerAutomationBroker: computerBroker } : {}),
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
      });
      const accountUsage = yield* makeProviderLimits({
        provider: "cursor",
        instanceId,
        displayName: displayName || "Cursor",
        enabled,
        environment: processEnv,
        apiEndpoint: effectiveConfig.apiEndpoint,
      });
      const serverConfig = yield* ServerConfig;
      const textGeneration = yield* makeCursorTextGeneration(effectiveConfig, processEnv, {
        scratchDir: cursorScratchDir(serverConfig.stateDir),
      });

      // The catalog the previous process published stays visible until a fresh one arrives.
      const persisted = yield* resolveProviderStatusCachePath({
        cacheDir:
          serverConfig.providerStatusCacheDir ??
          path.join(serverConfig.stateDir, "provider-status-cache"),
        instanceId,
      }).pipe(
        Effect.flatMap(readProviderStatusCache),
        Effect.map((cached) =>
          cached?.instanceId === instanceId && cached.driver === DRIVER_KIND ? cached : undefined,
        ),
        Effect.orElseSucceed(() => undefined),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      const modelCatalog = yield* makeCursorModelCatalogCache({
        settings: effectiveConfig,
        seed: seedCursorModelCatalog(persisted),
        fetch: fetchCursorModelCatalog(effectiveConfig, processEnv).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      });

      const checkProvider = checkCursorProviderStatus(effectiveConfig, processEnv).pipe(
        // User and Cursor-installed skills are workspace-independent; project
        // skills join per session.
        Effect.flatMap((draft) =>
          discoverCursorSkills(null, processEnv).pipe(
            Effect.map((skills) => ({ ...draft, skills })),
          ),
        ),
        Effect.map(stampIdentity),
        Effect.flatMap(modelCatalog.applyCached),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

      const snapshot = yield* makeManagedServerProvider<CursorSettings>({
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) => stampIdentity(buildInitialCursorProviderSnapshot(settings)),
        checkProvider,
        enrichSnapshot: modelCatalog.enrich,
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Cursor snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        resolveInstallTarget: makeInstanceInstallTargetResolver({
          driver: DRIVER_KIND,
          binaryPath: effectiveConfig.binaryPath,
          resolutionEnvironment: processEnv,
          instanceEnvironment: environment,
          instanceId,
        }),
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        accountUsage,
        usageHistory,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
