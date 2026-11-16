import * as FS from "node:fs/promises";
import * as Path from "node:path";
import * as Crypto from "node:crypto";
import { Deferred, Effect, Exit, Schema, Scope, SynchronizedRef } from "effect";
import { StorageUsageReport, type StorageScanStatus } from "@t3tools/contracts";
import { allocatedBytes } from "./diskUsage.ts";
import { userFacingCauseMessage } from "../causeMessage.ts";

export interface UsageScanState {
  readonly generation: number;
  readonly latest: { readonly report: StorageUsageReport; readonly generation: number } | null;
  readonly running: Deferred.Deferred<void> | null;
  readonly lastFailure: number | null;
  readonly revision: number;
  readonly scan: StorageScanStatus;
}
const idle: StorageScanStatus = {
  state: "idle",
  phase: null,
  entriesVisited: 0,
  startedAt: null,
  error: null,
};
export const makeUsageScanCoordinator = <E>(input: {
  readonly stateDir: string;
  readonly scan: (
    signal: AbortSignal,
    progress: (phase: NonNullable<StorageScanStatus["phase"]>, entries?: number) => void,
  ) => Effect.Effect<
    | StorageUsageReport
    | {
        readonly report: StorageUsageReport;
        readonly persistenceBytes: { readonly file: number; readonly directory: number };
      },
    E
  >;
  readonly measureBytes?: typeof allocatedBytes;
}) =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const persistedPath = Path.join(input.stateDir, "storage-usage.json");
    const persisted = yield* Effect.tryPromise(async () => {
      try {
        return Schema.decodeUnknownSync(StorageUsageReport)(
          JSON.parse(await FS.readFile(persistedPath, "utf8")),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not load saved storage measurement", error).pipe(Effect.as(null)),
      ),
    );
    const ref = yield* SynchronizedRef.make<UsageScanState>({
      generation: 0,
      latest: persisted ? { report: persisted, generation: -1 } : null,
      running: null,
      lastFailure: null,
      revision: 0,
      scan: idle,
    });
    const snapshot = SynchronizedRef.get(ref);
    const noteMutated = SynchronizedRef.update(ref, (state) => ({
      ...state,
      generation: state.generation + 1,
      revision: state.revision + 1,
    }));
    const request = (force = false) =>
      SynchronizedRef.modifyEffect(ref, (state) =>
        Effect.gen(function* () {
          if (
            state.running ||
            (!force && state.lastFailure !== null && Date.now() - state.lastFailure < 60_000)
          )
            return [undefined, state] as const;
          const done = yield* Deferred.make<void>();
          const run = Effect.gen(function* () {
            for (let attempt = 0; attempt < 3; attempt++) {
              const start = yield* snapshot;
              const controller = new AbortController();
              const progress = (phase: NonNullable<StorageScanStatus["phase"]>, entries = 0) => {
                Effect.runFork(
                  SynchronizedRef.update(ref, (current) =>
                    current.running === done &&
                    current.scan.state === "scanning" &&
                    !controller.signal.aborted
                      ? {
                          ...current,
                          revision: current.revision + 1,
                          scan: { ...current.scan, phase, entriesVisited: entries },
                        }
                      : current,
                  ),
                );
              };
              const result = yield* Effect.exit(
                input
                  .scan(controller.signal, progress)
                  .pipe(Effect.ensuring(Effect.sync(() => controller.abort()))),
              );
              if (Exit.isFailure(result)) {
                yield* Effect.logWarning("Storage scan failed", result.cause);
                yield* SynchronizedRef.update(ref, (current) => ({
                  ...current,
                  running: null,
                  lastFailure: Date.now(),
                  revision: current.revision + 1,
                  scan: {
                    ...current.scan,
                    state: "failed" as const,
                    phase: null,
                    error: userFacingCauseMessage(result.cause, "Storage scan failed.", {
                      maxLength: 300,
                    }),
                  },
                }));
                break;
              }
              if ((yield* snapshot).generation !== start.generation && attempt < 2) continue;
              const measurement = result.value;
              const original = "report" in measurement ? measurement.report : measurement;
              let report = original;
              yield* Effect.tryPromise(async () => {
                const temporary = `${persistedPath}.${Crypto.randomUUID()}.tmp`;
                const bytes = input.measureBytes ?? allocatedBytes;
                try {
                  for (let pass = 0; pass < 8; pass++) {
                    await FS.writeFile(
                      temporary,
                      JSON.stringify({
                        ...report,
                        categories: report.categories.map((category) => ({
                          ...category,
                          targets: category.targets
                            .toSorted((a, b) => b.bytes - a.bytes || a.id.localeCompare(b.id))
                            .slice(0, 500),
                        })),
                      }),
                    );
                    await FS.rename(temporary, persistedPath);
                    if (!("persistenceBytes" in measurement)) break;
                    // Include our own replacement in the measurement. Iterate
                    // until its serialized size stabilizes (logical bytes on
                    // Windows, allocated blocks on POSIX), without a second walk.
                    const delta =
                      bytes(await FS.lstat(persistedPath)) -
                      measurement.persistenceBytes.file +
                      bytes(await FS.lstat(input.stateDir)) -
                      measurement.persistenceBytes.directory;
                    const next = {
                      ...original,
                      totalUsedBytes: original.totalUsedBytes + delta,
                      otherBytes: Math.max(0, original.otherBytes + delta),
                    };
                    if (
                      next.totalUsedBytes === report.totalUsedBytes &&
                      next.otherBytes === report.otherBytes
                    )
                      break;
                    report = next;
                    if (pass === 7)
                      throw new Error("Storage measurement serialization did not stabilize.");
                  }
                } finally {
                  await FS.unlink(temporary).catch(() => {});
                }
              }).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Could not persist storage measurement", error),
                ),
              );
              // Persistence is part of the scan: callers joining awaitLatest
              // must not observe a report measured before its own writes.
              yield* SynchronizedRef.update(ref, (current) => ({
                ...current,
                latest: { report, generation: start.generation },
                running: current.running === done ? null : current.running,
                lastFailure: null,
                revision: current.revision + 1,
                scan:
                  current.running === done
                    ? { ...current.scan, state: "idle" as const, phase: null }
                    : current.scan,
              })).pipe(Effect.uninterruptible);
              break;
            }
          }).pipe(
            Effect.ensuring(Deferred.succeed(done, undefined)),
            Effect.ensuring(
              SynchronizedRef.update(ref, (current) =>
                current.running === done ? { ...current, running: null } : current,
              ),
            ),
          );
          yield* run.pipe(Effect.forkIn(scope));
          return [
            undefined,
            {
              ...state,
              running: done,
              revision: state.revision + 1,
              scan: {
                ...idle,
                state: "scanning" as const,
                phase: "database" as const,
                startedAt: new Date().toISOString(),
              },
            },
          ] as const;
        }),
      );
    const awaitLatest = Effect.gen(function* () {
      const state = yield* snapshot;
      if (state.running) yield* Deferred.await(state.running);
      return (yield* snapshot).latest;
    });
    return { snapshot, request, awaitLatest, noteMutated };
  });
