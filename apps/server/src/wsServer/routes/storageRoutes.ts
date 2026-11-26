import { WS_METHODS } from "@t3tools/contracts";
import { Effect, Option, type Path, Struct } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { DefaultBranchAutoPullShape } from "../../git/DefaultBranchAutoPull.ts";
import { listStorageAutomationAudit } from "../../storage/automationAudit.ts";
import type { DiskSpaceMonitor } from "../../storage/DiskSpaceMonitor.ts";
import { readScheduledBackupStatus } from "../../storage/scheduledBackups.ts";
import type { StorageCleanupWorkerShape } from "../../storage/StorageCleanupWorker.ts";
import type { StorageMaintenanceShape } from "../../storage/StorageMaintenance.ts";
import { RouteRequestError } from "../../turnSubmissionErrors.ts";
import type { RouteTable } from "./routeTable.ts";

type StorageMethod =
  | typeof WS_METHODS.storageGetUsage
  | typeof WS_METHODS.storageGetStatus
  | typeof WS_METHODS.storageGetTargets
  | typeof WS_METHODS.storageGetOperation
  | typeof WS_METHODS.storageCleanup
  | typeof WS_METHODS.storageGetDiskSpace
  | typeof WS_METHODS.storageCancelCleanup
  | typeof WS_METHODS.storageScheduleCompaction
  | typeof WS_METHODS.storageAutomationDryRun
  | typeof WS_METHODS.storageAutomationAudit;

export interface StorageRouteDependencies {
  readonly stateDir: string;
  readonly path: Pick<Path.Path, "join">;
  readonly sql: SqlClient.SqlClient;
  readonly diskSpaceMonitor: Option.Option<typeof DiskSpaceMonitor.Service>;
  readonly runtime: Effect.Effect<
    {
      readonly storageMaintenance: StorageMaintenanceShape;
      readonly storageCleanupWorker: StorageCleanupWorkerShape;
      readonly defaultBranchAutoPull: DefaultBranchAutoPullShape;
    },
    RouteRequestError
  >;
}

const withoutTag = <Body extends { readonly _tag: string }>(body: Body) =>
  Struct.omit(body, ["_tag"]);

/**
 * Storage usage, cleanup, compaction, disk space monitoring, and automation
 * audit routes.
 */
export const storageRoutes = ({
  stateDir,
  path,
  sql,
  diskSpaceMonitor,
  runtime,
}: StorageRouteDependencies): RouteTable<StorageMethod, never, RouteRequestError> => ({
  [WS_METHODS.storageGetUsage]: (request) =>
    Effect.gen(function* () {
      const { storageMaintenance } = yield* runtime;
      return yield* storageMaintenance
        .getUsage(withoutTag(request))
        .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
    }),

  [WS_METHODS.storageGetStatus]: () =>
    Effect.gen(function* () {
      const { storageMaintenance } = yield* runtime;
      return yield* storageMaintenance.getStatus;
    }),

  [WS_METHODS.storageGetTargets]: (request) =>
    Effect.gen(function* () {
      const { storageMaintenance } = yield* runtime;
      return yield* storageMaintenance
        .getTargets(withoutTag(request))
        .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
    }),

  [WS_METHODS.storageGetOperation]: (request) =>
    Effect.gen(function* () {
      const { storageMaintenance } = yield* runtime;
      return yield* storageMaintenance
        .getOperation(withoutTag(request))
        .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
    }),

  [WS_METHODS.storageCleanup]: (request) =>
    Effect.gen(function* () {
      const { storageMaintenance } = yield* runtime;
      return yield* storageMaintenance
        .acceptCleanup(withoutTag(request))
        .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
    }),

  [WS_METHODS.storageGetDiskSpace]: (request) =>
    Effect.gen(function* () {
      if (Option.isNone(diskSpaceMonitor)) {
        return yield* new RouteRequestError({
          message: "Free disk space monitoring is unavailable.",
        });
      }
      const body = withoutTag(request);
      return yield* diskSpaceMonitor.value.getStatus({ force: body.force ?? false });
    }),

  [WS_METHODS.storageCancelCleanup]: (request) =>
    Effect.gen(function* () {
      const { storageMaintenance } = yield* runtime;
      yield* storageMaintenance.cancel(request.operationId);
      return undefined;
    }),

  [WS_METHODS.storageScheduleCompaction]: (request) =>
    Effect.gen(function* () {
      const { storageMaintenance } = yield* runtime;
      const result = yield* storageMaintenance
        .scheduleCompaction(request.when)
        .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
      if (Option.isSome(diskSpaceMonitor)) {
        yield* diskSpaceMonitor.value.noteStorageChanged;
      }
      return result;
    }),

  [WS_METHODS.storageAutomationDryRun]: () =>
    Effect.gen(function* () {
      const { storageCleanupWorker, defaultBranchAutoPull } = yield* runtime;
      const cleanup = yield* storageCleanupWorker.dryRun;
      const pulls = yield* defaultBranchAutoPull.dryRun;
      return { ...cleanup, targets: [...cleanup.targets, ...pulls] };
    }),

  [WS_METHODS.storageAutomationAudit]: (request) =>
    Effect.gen(function* () {
      const body = withoutTag(request);
      const entries = yield* listStorageAutomationAudit(body.limit ?? 100, body.source).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError(
          (error) => new RouteRequestError({ message: `Cannot read audit: ${error.message}` }),
        ),
      );
      const scheduledBackupStatus = yield* Effect.tryPromise({
        try: () => readScheduledBackupStatus(path.join(stateDir, "backups")),
        catch: (cause) =>
          new RouteRequestError({ message: `Cannot read backup status: ${String(cause)}` }),
      });
      return { entries, scheduledBackupStatus };
    }),
});
