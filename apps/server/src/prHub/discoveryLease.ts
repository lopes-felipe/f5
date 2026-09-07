import { randomUUID } from "node:crypto";
import { Effect, Option, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { DiscoveryAccount } from "./discovery.ts";
import { SourceControlProviderError } from "../sourceControl/SourceControlProvider.ts";

export class PrHubDiscoveryLease extends ServiceMap.Service<
  PrHubDiscoveryLease,
  {
    readonly assertCurrent: Effect.Effect<void, SourceControlProviderError>;
  }
>()("t3/prHub/discoveryLease/PrHubDiscoveryLease") {}

export const assertPrHubDiscoveryLease = Effect.gen(function* () {
  const lease = yield* Effect.serviceOption(PrHubDiscoveryLease);
  if (Option.isSome(lease)) yield* lease.value.assertCurrent;
});

/** Lease-fenced checkpoint work. A lost lease interrupts reads and forbids publication. */
export function withPrHubDiscoveryLease<A, E, R>(
  account: DiscoveryAccount,
  kind: string,
  key: string,
  work: Effect.Effect<A, E, R>,
  now = Date.now,
) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const owner = randomUUID();
    const timestamp = () => new Date(now()).toISOString();
    const expiry = () => new Date(now() + 120_000).toISOString();
    const lost = () =>
      new SourceControlProviderError({
        provider: "github",
        operation: "prHub.discoveryLease",
        kind: "generic",
        detail:
          "The discovery lease expired or was superseded. Its work will resume with the current owner.",
      });
    // A failing query is not a lost lease. Reporting one as the other hides real storage
    // faults behind a message that invites an endless retry.
    const unreadable = (cause: unknown) =>
      new SourceControlProviderError({
        provider: "github",
        operation: "prHub.discoveryLease",
        kind: "generic",
        detail: "The discovery lease could not be read. Check local database health.",
        cause,
      });
    const acquire = sql<{
      task_key: string;
    }>`UPDATE pr_hub_sync_tasks SET lease_owner = ${owner}, lease_expires_at = ${expiry()}
      WHERE provider_kind = 'github' AND host = ${account.host} AND viewer_id = ${account.viewerId} AND kind = ${kind} AND task_key = ${key}
      AND (lease_expires_at IS NULL OR lease_expires_at <= ${timestamp()}) RETURNING task_key`;
    const assertCurrent = Effect.gen(function* () {
      const rows = yield* sql<{ task_key: string }>`SELECT task_key FROM pr_hub_sync_tasks
        WHERE provider_kind = 'github' AND host = ${account.host} AND viewer_id = ${account.viewerId} AND kind = ${kind} AND task_key = ${key}
        AND lease_owner = ${owner} AND lease_expires_at > ${timestamp()}`.pipe(
        Effect.mapError(unreadable),
      );
      if (!rows.length) return yield* lost();
    });
    const renew = Effect.forever(
      Effect.sleep(30_000).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const rows = yield* sql<{
              task_key: string;
            }>`UPDATE pr_hub_sync_tasks SET lease_expires_at = ${expiry()}
        WHERE provider_kind = 'github' AND host = ${account.host} AND viewer_id = ${account.viewerId} AND kind = ${kind} AND task_key = ${key}
        AND lease_owner = ${owner} AND lease_expires_at > ${timestamp()} RETURNING task_key`.pipe(
              Effect.mapError(unreadable),
            );
            if (!rows.length) return yield* lost();
          }),
        ),
      ),
    );
    return yield* Effect.acquireUseRelease(
      acquire,
      (rows) =>
        rows.length
          ? Effect.raceFirst(work, renew).pipe(
              Effect.provideService(PrHubDiscoveryLease, { assertCurrent }),
              Effect.map(Option.some),
            )
          : Effect.succeed(Option.none<A>()),
      () =>
        sql`UPDATE pr_hub_sync_tasks SET lease_owner = NULL, lease_expires_at = NULL
      WHERE provider_kind = 'github' AND host = ${account.host} AND viewer_id = ${account.viewerId} AND kind = ${kind} AND task_key = ${key}
      AND lease_owner = ${owner}`.pipe(Effect.orDie),
    );
  });
}

/** Stable lease row survives checkpoint replacement and connection completion. */
export function withPrHubDiscoveryWork<A, E, R>(
  account: DiscoveryAccount,
  kind: string,
  key: string,
  work: Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = new Date().toISOString();
    const leaseKind = `${kind}_lease`;
    yield* sql`INSERT INTO pr_hub_sync_tasks(provider_kind,host,viewer_id,kind,task_key,payload_json,created_at,updated_at)
      VALUES('github',${account.host},${account.viewerId},${leaseKind},${key},'{}',${now},${now}) ON CONFLICT DO NOTHING`;
    return yield* withPrHubDiscoveryLease(account, leaseKind, key, work);
  });
}
