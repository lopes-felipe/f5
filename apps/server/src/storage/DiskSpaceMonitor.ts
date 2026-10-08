import type { DiskSpaceReclaimableItem, DiskSpaceStatus } from "@t3tools/contracts";
import { Cause, Effect, Layer, Path, PubSub, Schedule, ServiceMap, Stream } from "effect";
import type { Scope } from "effect";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  CRITICAL_DISK_SPACE_BYTES,
  diskSpaceHoldDetail,
  inspectVolumes,
  LOW_DISK_SPACE_BYTES,
  resolveWatchedPaths,
  type VolumeStatReader,
  worstDiskSpaceLevel,
} from "./diskSpace.ts";

/**
 * Watches free space on the volumes F5 and its providers write to (see
 * `diskSpace.ts`). Checks before every turn start and once a minute, pushes
 * changes to the UI, and while space is short attaches the largest
 * reclaimable storage categories so the banner can point at them.
 */
export interface DiskSpaceMonitorShape {
  /** The latest status, checked again when older than a few seconds or when forced. */
  readonly getStatus: (input?: { readonly force?: boolean }) => Effect.Effect<DiskSpaceStatus>;
  /** Why new turns are held, or null when they may start. Never fails: an unreadable disk does not block turns. */
  readonly turnStartHold: Effect.Effect<string | null>;
  /** A status whenever its level, a volume's free space, or the reclaimable list changes. */
  readonly changes: Stream.Stream<DiskSpaceStatus>;
  /**
   * After a storage cleanup: checks free space now and drops the reclaimable
   * list, which the next periodic check rebuilds while space is still short.
   */
  readonly noteStorageChanged: Effect.Effect<void>;
  /**
   * Periodic checks. `estimateReclaimable` is the storage scan behind the
   * banner's list; it runs only while space is short, at most every
   * {@link RECLAIMABLE_MAX_AGE_MS}.
   */
  readonly start: <E>(input: {
    readonly estimateReclaimable: Effect.Effect<ReadonlyArray<DiskSpaceReclaimableItem>, E>;
  }) => Effect.Effect<void, never, Scope.Scope>;
}

export class DiskSpaceMonitor extends ServiceMap.Service<DiskSpaceMonitor, DiskSpaceMonitorShape>()(
  "t3/storage/DiskSpaceMonitor",
) {}

/** A turn start reuses a check this recent; statfs is cheap, but turns can burst. */
const STATUS_MAX_AGE_MS = 5_000;
const CHECK_INTERVAL = "1 minute";
/**
 * The reclaimable scan walks userdata and worktrees and sizes purgeable
 * threads in the database, which shares its connection; keep it rare.
 */
const RECLAIMABLE_MAX_AGE_MS = 30 * 60 * 1_000;
const RECLAIMABLE_LIMIT = 5;
/** Free-space drift below this does not push a new status. */
const PUBLISH_FREE_BYTES_STEP = 256 * 1024 ** 2;

/** What the UI shows besides free space. */
const shapeKey = (status: DiskSpaceStatus) =>
  JSON.stringify([
    status.level,
    status.volumes.map((volume) => [volume.path, volume.level]),
    status.reclaimable,
  ]);

/** Pushed when the shape changes or a volume's free space moved by a step since the last push. */
export function isSignificantDiskSpaceChange(
  previous: DiskSpaceStatus | null,
  next: DiskSpaceStatus,
): boolean {
  if (previous === null || shapeKey(previous) !== shapeKey(next)) return true;
  return next.volumes.some(
    (volume, index) =>
      Math.abs(volume.freeBytes - (previous.volumes[index]?.freeBytes ?? 0)) >=
      PUBLISH_FREE_BYTES_STEP,
  );
}

export const makeDiskSpaceMonitor = (options?: {
  readonly readStat?: VolumeStatReader;
  readonly now?: () => number;
}) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const path = yield* Path.Path;
    const settingsService = yield* Effect.serviceOption(ServerSettingsService);
    const now = options?.now ?? Date.now;
    const changesPubSub = yield* PubSub.unbounded<DiskSpaceStatus>();
    const checkSemaphore = yield* Semaphore.make(1);

    let current: { readonly status: DiskSpaceStatus; readonly checkedAtMs: number } | null = null;
    let reclaimable: {
      readonly items: ReadonlyArray<DiskSpaceReclaimableItem>;
      readonly computedAtMs: number;
    } | null = null;
    let reclaimableGeneration = 0;
    let lastPublished: DiskSpaceStatus | null = null;

    const publishIfChanged = (status: DiskSpaceStatus) =>
      Effect.suspend(() => {
        if (!isSignificantDiskSpaceChange(lastPublished, status)) return Effect.void;
        lastPublished = status;
        return PubSub.publish(changesPubSub, status).pipe(Effect.asVoid);
      });

    const check = Effect.gen(function* () {
      const settings =
        settingsService._tag === "Some"
          ? yield* settingsService.value.getSettings.pipe(Effect.orElseSucceed(() => null))
          : null;
      const watched = yield* resolveWatchedPaths({
        stateDir: config.stateDir,
        worktreesDir: config.worktreesDir,
        settings,
        profile: config.profile,
      }).pipe(Effect.provideService(Path.Path, path));
      const volumes = yield* Effect.promise(() =>
        inspectVolumes({ watched, ...(options?.readStat ? { readStat: options.readStat } : {}) }),
      );
      const checkedAtMs = now();
      const level = worstDiskSpaceLevel(volumes.map((volume) => volume.level));
      if (level === "ok") reclaimable = null;
      const status: DiskSpaceStatus = {
        level,
        checkedAt: new Date(checkedAtMs).toISOString(),
        lowThresholdBytes: LOW_DISK_SPACE_BYTES,
        criticalThresholdBytes: CRITICAL_DISK_SPACE_BYTES,
        volumes,
        reclaimable: level === "ok" ? [] : (reclaimable?.items ?? []),
      };
      const previousLevel = current?.status.level ?? "ok";
      current = { status, checkedAtMs };
      if (level !== previousLevel) {
        yield* (level === "ok" ? Effect.logInfo : Effect.logWarning)("free disk space changed", {
          level,
          previousLevel,
          volumes: volumes.map((volume) => ({
            path: volume.path,
            roles: volume.roles,
            freeBytes: volume.freeBytes,
          })),
        });
      }
      yield* publishIfChanged(status);
      return status;
    });

    const getStatus: DiskSpaceMonitorShape["getStatus"] = (input) =>
      checkSemaphore.withPermits(1)(
        Effect.suspend(() =>
          !input?.force && current !== null && now() - current.checkedAtMs < STATUS_MAX_AGE_MS
            ? Effect.succeed(current.status)
            : check,
        ),
      );

    const turnStartHold: DiskSpaceMonitorShape["turnStartHold"] = getStatus().pipe(
      Effect.map(diskSpaceHoldDetail),
      Effect.catchCause((cause) =>
        Effect.logWarning("free disk space check failed; not holding the turn", {
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(null)),
      ),
    );

    const noteStorageChanged: DiskSpaceMonitorShape["noteStorageChanged"] = Effect.suspend(() => {
      reclaimable = null;
      // An estimate already running scanned before the change.
      reclaimableGeneration += 1;
      if (current !== null)
        current = { ...current, status: { ...current.status, reclaimable: [] } };
      return getStatus({ force: true });
    }).pipe(Effect.asVoid);

    const start: DiskSpaceMonitorShape["start"] = ({ estimateReclaimable }) =>
      Effect.gen(function* () {
        let estimating = false;
        const refreshReclaimable = Effect.suspend(() => {
          if (
            estimating ||
            current === null ||
            current.status.level === "ok" ||
            (reclaimable !== null && now() - reclaimable.computedAtMs < RECLAIMABLE_MAX_AGE_MS)
          ) {
            return Effect.void;
          }
          estimating = true;
          const generation = reclaimableGeneration;
          return estimateReclaimable.pipe(
            Effect.flatMap((items) =>
              Effect.suspend(() => {
                if (generation !== reclaimableGeneration) return Effect.void;
                reclaimable = { items: items.slice(0, RECLAIMABLE_LIMIT), computedAtMs: now() };
                if (current === null || current.status.level === "ok") return Effect.void;
                const status = { ...current.status, reclaimable: reclaimable.items };
                current = { ...current, status };
                return publishIfChanged(status);
              }),
            ),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("reclaimable storage estimate failed", {
                    cause: Cause.pretty(cause),
                  }),
            ),
            Effect.ensuring(Effect.sync(() => (estimating = false))),
          );
        });
        const tick = getStatus({ force: true }).pipe(
          Effect.andThen(refreshReclaimable.pipe(Effect.forkScoped)),
          Effect.asVoid,
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("free disk space check failed", { cause: Cause.pretty(cause) }),
          ),
        );
        yield* tick.pipe(Effect.repeat(Schedule.spaced(CHECK_INTERVAL)), Effect.forkScoped);
      });

    return {
      getStatus,
      turnStartHold,
      changes: Stream.fromPubSub(changesPubSub),
      noteStorageChanged,
      start,
    } satisfies DiskSpaceMonitorShape;
  });

export const DiskSpaceMonitorLive = Layer.effect(DiskSpaceMonitor, makeDiskSpaceMonitor());
