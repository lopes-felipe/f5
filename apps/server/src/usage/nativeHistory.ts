import { Cause, Clock, Effect } from "effect";
import type { MuseHistoryRecord } from "./museHistory.ts";

export type NativeHistoryStatus = "idle" | "refreshing" | "ready" | "error";
export interface NativeHistorySnapshot {
  readonly source: string | null;
  readonly records: readonly MuseHistoryRecord[];
  readonly status: NativeHistoryStatus;
  readonly errorMessage?: string;
  readonly refreshedAt?: number;
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
    let failures = 0;
    const refresh = Effect.gen(function* () {
      if (!options.enabled) return;
      const now = yield* Clock.currentTimeMillis;
      if (snapshot.status === "refreshing") return;
      if (now < nextRefreshAt) return;
      snapshot = { ...snapshot, status: "refreshing" };
      let phase: "discovery" | "scan" = home ? "scan" : "discovery";
      yield* Effect.gen(function* () {
        home ??= yield* options.discover.pipe(Effect.timeout("5 seconds"));
        phase = "scan";
        const records = yield* options.scan(home).pipe(Effect.timeout("2 minutes"));
        failures = 0;
        snapshot = {
          source: home,
          records,
          status: "ready",
          refreshedAt: yield* Clock.currentTimeMillis,
        };
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            failures++;
            const error = Cause.squash(cause);
            const timeout = error instanceof Error && error.name === "TimeoutError";
            let underlying: unknown = error;
            for (let depth = 0; depth < 3; depth++) {
              if (
                underlying &&
                typeof underlying === "object" &&
                "cause" in underlying &&
                underlying.cause !== undefined
              )
                underlying = underlying.cause;
              else break;
            }
            const code =
              underlying && typeof underlying === "object" && "code" in underlying
                ? underlying.code
                : undefined;
            const name = underlying instanceof Error ? underlying.name : "";
            const reason =
              code === "EACCES" || code === "EPERM"
                ? "permission denied"
                : code === "ENOENT" || name === "CommandNotFoundError"
                  ? "file or executable not found"
                  : name === "ProtocolError"
                    ? "incompatible Muse protocol"
                    : timeout
                      ? "timeout"
                      : "";
            const errorMessage =
              phase === "discovery"
                ? timeout
                  ? "Muse home discovery timed out. Check the configured Muse CLI installation."
                  : "Muse home discovery failed. Check that the configured CLI is installed and can initialize."
                : timeout
                  ? "Muse history scan timed out. Previously loaded history is retained."
                  : "Muse history could not be read. Check access to the configured history directory.";
            snapshot = {
              ...snapshot,
              status: "error",
              errorMessage: errorMessage + (reason ? " Reason: " + reason + "." : ""),
            };
            // Log the phase/type without provider output, environment values or credentials.
            yield* Effect.logWarning("Native history refresh failed", {
              phase,
              failureType: reason || "provider-or-filesystem",
            });
          }),
        ),
        Effect.ensuring(
          Effect.gen(function* () {
            nextRefreshAt =
              (yield* Clock.currentTimeMillis) +
              Math.min(10 * 60_000, 30_000 * 2 ** Math.min(5, Math.max(0, failures - 1)));
          }),
        ),
        Effect.forkIn(scope),
      );
    });
    return { refresh, getSnapshot: Effect.sync(() => snapshot) } satisfies NativeHistoryCapability;
  });
