import { Clock, Effect } from "effect";
import type { MuseHistoryRecord } from "./museHistory.ts";

export type NativeHistoryStatus = "idle" | "refreshing" | "ready" | "error";
export interface NativeHistorySnapshot {
  readonly source: string | null;
  readonly records: readonly MuseHistoryRecord[];
  readonly status: NativeHistoryStatus;
}
export interface NativeHistoryCapability {
  readonly refresh: Effect.Effect<void>;
  readonly getSnapshot: Effect.Effect<NativeHistorySnapshot>;
}

/** Requesting a refresh never waits for discovery/IO. Failures retain the last good snapshot. */
export const makeNativeHistoryCapability = <E, E2>(options: {
  readonly enabled: boolean;
  readonly discover: Effect.Effect<string, E>;
  readonly scan: (home: string) => Effect.Effect<readonly MuseHistoryRecord[], E2>;
}) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    let home: string | undefined;
    let snapshot: NativeHistorySnapshot = { source: null, records: [], status: "idle" };
    let nextRefreshAt = 0;
    const refresh = Effect.gen(function* () {
      if (!options.enabled) return;
      const now = yield* Clock.currentTimeMillis;
      if (snapshot.status === "refreshing") return;
      if (now < nextRefreshAt) return;
      snapshot = { ...snapshot, status: "refreshing" };
      yield* Effect.gen(function* () {
        home ??= yield* options.discover.pipe(Effect.timeout("5 seconds"));
        const records = yield* options.scan(home).pipe(Effect.timeout("2 minutes"));
        snapshot = { source: home, records, status: "ready" };
      }).pipe(
        Effect.catchCause(() =>
          Effect.sync(() => {
            snapshot = { ...snapshot, status: "error" };
          }),
        ),
        Effect.ensuring(
          Effect.gen(function* () {
            nextRefreshAt = (yield* Clock.currentTimeMillis) + 30_000;
          }),
        ),
        Effect.forkIn(scope),
      );
    });
    return { refresh, getSnapshot: Effect.sync(() => snapshot) } satisfies NativeHistoryCapability;
  });
