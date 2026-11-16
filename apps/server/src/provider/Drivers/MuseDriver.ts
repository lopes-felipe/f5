/**
 * MuseDriver — `ProviderDriver` for Meta's Muse Code CLI, spoken over the
 * Muse Session Protocol (`muse serve`).
 *
 * Muse Code is the coding CLI; the Muse personal agent has no public API and
 * F5 does not imitate it.
 *
 * @module provider/Drivers/MuseDriver
 */
import { MuseSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { Duration, Effect, FileSystem, Schema, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { version as serverVersion } from "../../../package.json" with { type: "json" };
import { ServerConfig } from "../../config.ts";
import { makeMuseTextGeneration } from "../../git/Layers/MuseTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeMuseAdapter } from "../Layers/MuseAdapter.ts";
import {
  buildInitialMuseProviderSnapshot,
  checkMuseProviderStatus,
} from "../Layers/MuseProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { memoryNativeCommandIdStore, sqlNativeCommandIdStore } from "../msp/nativeCommandIds.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeMuseUsageHistory } from "./MuseUsageHistory.ts";

const DRIVER_KIND = ProviderDriverKind.make("muse");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);

export type MuseDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | ProviderEventLoggers
  | ServerConfig;

export const MuseDriver: ProviderDriver<MuseSettings, MuseDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Muse Code",
    supportsMultipleInstances: true,
  },
  configSchema: MuseSettings,
  defaultConfig: (): MuseSettings => Schema.decodeSync(MuseSettings)({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const eventLoggers = yield* ProviderEventLoggers;
      const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
      const processEnv = mergeProviderInstanceEnvironment(environment, process.env);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = (snapshot: ServerProviderDraft): ServerProvider => ({
        ...snapshot,
        instanceId,
        driver: DRIVER_KIND,
        ...(displayName ? { displayName } : {}),
        ...(accentColor ? { accentColor } : {}),
        continuation: { groupKey: continuationIdentity.continuationKey },
      });
      const effectiveConfig = { ...config, enabled } satisfies MuseSettings;
      const usageHistory = yield* makeMuseUsageHistory(config, processEnv, enabled);

      const adapter = yield* makeMuseAdapter(effectiveConfig, {
        instanceId,
        environment: processEnv,
        clientVersion: serverVersion,
        nativeCommandIds:
          sql._tag === "Some" ? sqlNativeCommandIdStore(sql.value) : memoryNativeCommandIdStore(),
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });
      const textGeneration = yield* makeMuseTextGeneration(effectiveConfig, processEnv);
      const checkProvider = checkMuseProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const snapshot = yield* makeManagedServerProvider<MuseSettings>({
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) => stampIdentity(buildInitialMuseProviderSnapshot(settings)),
        checkProvider,
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Muse Code snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
        usageHistory,
      } satisfies ProviderInstance;
    }),
};
