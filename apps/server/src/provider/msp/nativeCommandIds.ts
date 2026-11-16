/**
 * Native command identity: F5 mints the provider command id before the first
 * send and stores it, so every retry of one F5 delivery whose outcome is
 * unknown reuses it and the host's command-id dedupe joins the original
 * outcome. Once the host has answered, the id is forgotten: a later retry of
 * the same delivery is a new attempt and must not replay the old answer.
 *
 * @module provider/msp/nativeCommandIds
 */
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

/** Long past any delivery retry window; rows older than this are pruned. */
export const NATIVE_COMMAND_ID_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export interface NativeCommandIdStore {
  readonly resolve: (input: {
    readonly providerInstanceId: string;
    readonly f5CommandId: string;
    readonly mint: () => string;
  }) => Effect.Effect<string>;
  /** Drops the stored id so the next resolve mints a fresh one. */
  readonly forget: (f5CommandId: string) => Effect.Effect<void>;
}

export function sqlNativeCommandIdStore(
  sql: SqlClient.SqlClient,
  now: () => number = Date.now,
): NativeCommandIdStore {
  let lastPruneAt = 0;
  const prune = (providerInstanceId: string) =>
    Effect.suspend(() => {
      const at = now();
      if (at - lastPruneAt < PRUNE_INTERVAL_MS) return Effect.void;
      lastPruneAt = at;
      const before = new Date(at - NATIVE_COMMAND_ID_RETENTION_MS).toISOString();
      return sql`DELETE FROM provider_native_command_ids
        WHERE provider_instance_id = ${providerInstanceId} AND created_at < ${before}`.pipe(
        Effect.ignore,
      );
    });
  return {
    resolve: ({ providerInstanceId, f5CommandId, mint }) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT OR IGNORE INTO provider_native_command_ids
              (f5_command_id, provider_instance_id, native_command_id, created_at)
              VALUES (${f5CommandId}, ${providerInstanceId}, ${mint()}, ${new Date(now()).toISOString()})`;
            const rows = yield* sql<{ readonly native_command_id: string }>`
              SELECT native_command_id FROM provider_native_command_ids
              WHERE f5_command_id = ${f5CommandId}`;
            const stored = rows[0]?.native_command_id;
            if (!stored) return yield* Effect.die(new Error("native command id was not stored"));
            return stored;
          }),
        )
        .pipe(
          Effect.orDie,
          Effect.tap(() => prune(providerInstanceId)),
        ),
    forget: (f5CommandId) =>
      sql`DELETE FROM provider_native_command_ids WHERE f5_command_id = ${f5CommandId}`.pipe(
        Effect.asVoid,
        Effect.orDie,
      ),
  };
}

/** For hosts without persistence (tests, text generation). */
export function memoryNativeCommandIdStore(): NativeCommandIdStore {
  const ids = new Map<string, string>();
  return {
    resolve: ({ f5CommandId, mint }) =>
      Effect.sync(() => {
        const existing = ids.get(f5CommandId);
        if (existing) return existing;
        const minted = mint();
        ids.set(f5CommandId, minted);
        return minted;
      }),
    forget: (f5CommandId) =>
      Effect.sync(() => {
        ids.delete(f5CommandId);
      }),
  };
}
