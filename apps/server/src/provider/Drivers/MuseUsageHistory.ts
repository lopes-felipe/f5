import { Effect } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { MuseSettings } from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MUSE_SERVE_ARGS } from "@t3tools/shared/museProtocolManifest";
import { version } from "../../../package.json" with { type: "json" };
import { expandHomePath } from "../../pathExpansion.ts";
import { makeNativeHistoryCapability } from "../../usage/nativeHistory.ts";
import { scanMuseHistory, type MuseHistoryRecord } from "../../usage/museHistory.ts";
import { makeMspTransport } from "../msp/MspTransport.ts";
import { openMspHost } from "../msp/MspSessionRuntime.ts";
import { realpath } from "node:fs/promises";

/** Only durable per-turn identity participates; live runtime/turn projections may be replaced. */
export const museRecordedIntervals = (sql: SqlClient.SqlClient) => sql<{
  sessionId: string;
  startedAt: string | null;
  endedAt: string;
}>`
  SELECT native_session_id AS "sessionId", started_at AS "startedAt", completed_at AS "endedAt"
  FROM projection_turn_usage_facts
  WHERE provider_name = 'muse' AND native_session_id IS NOT NULL
`;

export const makeMuseUsageHistory = (
  config: MuseSettings,
  environment: NodeJS.ProcessEnv,
  enabled: boolean,
) =>
  Effect.gen(function* () {
    const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const discover = Effect.scoped(
      Effect.gen(function* () {
        const transport = yield* makeMspTransport({
          binaryPath: expandHomePath(config.binaryPath || "muse"),
          args: [...MUSE_SERVE_ARGS, "--disable-shell", "--disable-write", "--no-session-log"],
          cwd: process.cwd(),
          environment: { ...environment, MUSE_NO_AUTO_UPDATE: "1" },
        });
        const host = yield* Effect.acquireRelease(
          Effect.tryPromise(() =>
            openMspHost({ transport: transport.transport, clientVersion: version }),
          ).pipe(Effect.interruptible),
          (host) => Effect.promise(() => host.close().catch(() => undefined)),
        );
        return yield* Effect.tryPromise(() => realpath(host.initializeResult.museHome));
      }),
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
    return yield* makeNativeHistoryCapability({
      enabled,
      discover,
      scan: (home) =>
        Effect.gen(function* () {
          const intervals = sql._tag === "Some" ? yield* museRecordedIntervals(sql.value) : [];
          const bySession = new Map<string, Array<(typeof intervals)[number]>>();
          for (const interval of intervals) {
            const entries = bySession.get(interval.sessionId) ?? [];
            entries.push(interval);
            bySession.set(interval.sessionId, entries);
          }
          const isRecorded = (record: MuseHistoryRecord) =>
            (bySession.get(record.sessionId) ?? []).some(
              (interval) =>
                (interval.startedAt === null || record.timestamp >= interval.startedAt) &&
                record.timestamp <= interval.endedAt,
            );
          return yield* Effect.tryPromise((signal) => scanMuseHistory(home, isRecorded, signal));
        }),
    });
  });
