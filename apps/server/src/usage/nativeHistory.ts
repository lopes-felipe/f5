import { Cause, Clock, Deferred, Effect } from "effect";
import type { MuseHistoryRecord } from "./museHistory.ts";
import type { ExternalHistoryProvider, NativeUsageRecord } from "./nativeUsageRecord.ts";
import {
  DEFAULT_USAGE_HISTORY_RETENTION_DAYS,
  type UsageHistoryRetention,
} from "@t3tools/contracts";

export type NativeHistoryStatus = "idle" | "refreshing" | "ready" | "error";
export interface NativeHistorySnapshot {
  readonly source: string | null;
  readonly records: readonly (MuseHistoryRecord | NativeUsageRecord)[];
  readonly status: NativeHistoryStatus;
  readonly errorMessage?: string;
  readonly refreshedAt?: number;
}
export interface NativeHistoryCapability {
  readonly provider?: ExternalHistoryProvider;
  readonly refresh: (retention?: UsageHistoryRetention) => Effect.Effect<void>;
  readonly getSnapshot: Effect.Effect<NativeHistorySnapshot>;
}

/** Requesting a refresh never waits for discovery/IO. Failures retain the last good snapshot. */
export const makeNativeHistoryCapability = <E, E2>(options: {
  readonly enabled: boolean;
  readonly provider?: ExternalHistoryProvider;
  readonly displayName?: string;
  readonly discover: Effect.Effect<string, E>;
  readonly resolveAccount?: Effect.Effect<{ source: string; token: string }, E>;
  readonly scan: (
    home: string,
    retention: UsageHistoryRetention,
    token?: string,
  ) => Effect.Effect<readonly (MuseHistoryRecord | NativeUsageRecord)[], E2>;
}) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    let home: string | undefined;
    let snapshot: NativeHistorySnapshot = { source: null, records: [], status: "idle" };
    let nextRefreshAt = 0;
    let failures = 0;
    let accountCheck: Deferred.Deferred<void> | undefined;
    let lastRetention: UsageHistoryRetention | undefined;
    const name = options.displayName ?? "Muse";
    const refresh = (retention: UsageHistoryRetention = DEFAULT_USAGE_HISTORY_RETENTION_DAYS) =>
      Effect.gen(function* () {
        if (!options.enabled) return;
        const now = yield* Clock.currentTimeMillis;
        if (snapshot.status === "refreshing") return;
        const withinRefreshWindow = now < nextRefreshAt && retention === lastRetention;
        if (withinRefreshWindow && !options.resolveAccount) return;
        const previous = snapshot;
        let checkedCachedAccount = false;
        if (options.resolveAccount) snapshot = { source: null, records: [], status: "refreshing" };
        snapshot = { ...snapshot, status: "refreshing" };
        const checked = options.resolveAccount ? yield* Deferred.make<void>() : undefined;
        accountCheck = checked;
        let phase: "discovery" | "scan" = home && !options.resolveAccount ? "scan" : "discovery";
        yield* Effect.gen(function* () {
          const account = options.resolveAccount
            ? yield* options.resolveAccount.pipe(Effect.timeout("12 seconds"))
            : undefined;
          if (account) {
            home = account.source;
            if (home === previous.source) {
              if (withinRefreshWindow) {
                checkedCachedAccount = true;
                snapshot = previous;
                return;
              }
              snapshot = { ...previous, status: "refreshing" };
            } else {
              snapshot = { source: home, records: [], status: "refreshing" };
            }
          }
          home ??= yield* options.discover.pipe(Effect.timeout("5 seconds"));
          lastRetention = retention;
          phase = "scan";
          if (checked) yield* Deferred.succeed(checked, undefined);
          const records = yield* options
            .scan(home, retention, account?.token)
            .pipe(Effect.timeout("2 minutes"));
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
              const errorName = underlying instanceof Error ? underlying.name : "";
              const reason =
                code === "EACCES" || code === "EPERM"
                  ? "permission denied"
                  : code === "ENOENT" || errorName === "CommandNotFoundError"
                    ? "file or executable not found"
                    : errorName === "ProtocolError"
                      ? "incompatible Muse protocol"
                      : timeout
                        ? "timeout"
                        : "";
              const errorMessage =
                phase === "discovery"
                  ? timeout
                    ? `${name} home discovery timed out.`
                    : `${name} home discovery failed.`
                  : timeout
                    ? `${name} history scan timed out.`
                    : `${name} history could not be read. Check your login or access to the history directory.`;
              snapshot = {
                ...(underlying instanceof Error && underlying.name === "CursorAuthenticationError"
                  ? { source: null, records: [] }
                  : snapshot),
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
              if (checked) yield* Deferred.succeed(checked, undefined);
              if (checkedCachedAccount) return;
              nextRefreshAt =
                (yield* Clock.currentTimeMillis) +
                Math.min(10 * 60_000, 30_000 * 2 ** Math.min(5, Math.max(0, failures - 1)));
            }),
          ),
          Effect.forkIn(scope),
        );
      });
    return {
      ...(options.provider ? { provider: options.provider } : {}),
      refresh,
      getSnapshot: Effect.suspend(() =>
        accountCheck
          ? Deferred.await(accountCheck).pipe(Effect.map(() => snapshot))
          : Effect.succeed(snapshot),
      ),
    } satisfies NativeHistoryCapability;
  });
