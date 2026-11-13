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
import { externalMuseHistory, readMuseHistory } from "../../usage/museHistory.ts";
import { makeMspTransport } from "../msp/MspTransport.ts";
import { openMspHost } from "../msp/MspSessionRuntime.ts";
import { MUSE_SERVE_ARGS } from "@t3tools/shared/museProtocolManifest";
import { expandHomePath } from "../../pathExpansion.ts";

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
      let discoveredHome: string | undefined;
      const readHistory = yield* Effect.cachedWithTTL(
        Effect.scoped(
          Effect.gen(function* () {
            if (!discoveredHome) {
              const transport = yield* makeMspTransport({
                binaryPath: expandHomePath(config.binaryPath || "muse"),
                args: [
                  ...MUSE_SERVE_ARGS,
                  "--disable-shell",
                  "--disable-write",
                  "--no-session-log",
                ],
                cwd: process.cwd(),
                environment: { ...processEnv, MUSE_NO_AUTO_UPDATE: "1" },
              });
              const host = yield* Effect.acquireRelease(
                Effect.tryPromise(() =>
                  openMspHost({ transport: transport.transport, clientVersion: serverVersion }),
                ),
                (host) => Effect.promise(() => host.close().catch(() => undefined)),
              );
              discoveredHome = host.initializeResult.museHome;
            }
            if (!discoveredHome) return [];
            return yield* Effect.tryPromise((signal) => readMuseHistory(discoveredHome!, signal));
          }),
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.timeoutOption("30 seconds"),
          Effect.map((result) => (result._tag === "Some" ? result.value : [])),
          Effect.orElseSucceed(() => []),
        ),
        "30 seconds",
      );
      const usageHistory = Effect.gen(function* () {
        const records = yield* readHistory;
        const sessions =
          sql._tag === "Some"
            ? yield* sql.value<{ sessionId: string | null; startedAt: string; endedAt: string }>`
              SELECT json_extract(r.resume_cursor_json, '$.mspSessionId') AS "sessionId",
                COALESCE(t.started_at, t.requested_at) AS "startedAt", f.completed_at AS "endedAt"
              FROM provider_session_runtime r
              JOIN projection_turn_usage_facts f ON f.thread_id = r.thread_id
              JOIN projection_turns t ON t.turn_id = f.turn_id AND t.thread_id = f.thread_id
              WHERE r.provider_name = 'muse' AND f.provider_name = 'muse'
            `
            : [];
        const bySession = new Map<string, Array<(typeof sessions)[number]>>();
        for (const session of sessions) {
          if (!session.sessionId) continue;
          const intervals = bySession.get(session.sessionId) ?? [];
          intervals.push(session);
          bySession.set(session.sessionId, intervals);
        }
        return externalMuseHistory(records, (record) =>
          (bySession.get(record.sessionId) ?? []).some(
            (session) =>
              session.sessionId === record.sessionId &&
              record.timestamp >= session.startedAt &&
              record.timestamp <= session.endedAt,
          ),
        );
      }).pipe(Effect.orElseSucceed(() => []));

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
