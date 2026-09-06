import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type {
  PrHubClaimNotificationsInput,
  PrHubAcknowledgeNotificationsInput,
  PrHubNotificationBatch,
  PrHubSnapshot,
} from "@t3tools/contracts";
import { matchesPrHubFilter } from "@t3tools/shared/prHub";

export function claimPrHubNotifications(
  snapshot: PrHubSnapshot,
  input: PrHubClaimNotificationsInput,
  now = Date.now(),
) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const batch: PrHubNotificationBatch = {
      accountGeneration: input.accountGeneration,
      batchId: randomUUID(),
      expiresAt: new Date(now + 30_000).toISOString(),
      pullRequests: [],
    };
    if (!snapshot.account || snapshot.account.generation !== input.accountGeneration) return batch;
    const selected: PrHubNotificationBatch["pullRequests"][number][] = [];
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const pr of snapshot.pullRequests) {
          if (pr.repositoryArchived) continue;
          if (selected.length >= Math.min(20, input.maxItems)) break;
          if (!matchesPrHubFilter(pr, "needs_you", undefined, now)) continue;
          const claimed = yield* sql<{ number: number }>`UPDATE pr_hub_viewer_state
          SET notification_lease_owner = ${input.clientId}, notification_lease_expires_at = ${batch.expiresAt},
            notification_claimed_version = ${pr.attentionFingerprint}, notification_batch_id = ${batch.batchId}
          WHERE provider_kind = ${pr.provider} AND host = ${pr.host} AND viewer_id = ${String(snapshot.account!.viewerId)}
            AND repo = ${pr.repository.nameWithOwner} AND number = ${pr.number}
            AND attention_fingerprint = ${pr.attentionFingerprint} AND attention_bucket = 'needs_you'
            AND (last_seen_fingerprint IS NULL OR last_seen_fingerprint <> attention_fingerprint)
            AND (last_notified_fingerprint IS NULL OR last_notified_fingerprint <> attention_fingerprint)
            AND ignored_at IS NULL AND (snoozed_until IS NULL OR snoozed_until <= ${new Date(now).toISOString()})
            AND (notification_lease_expires_at IS NULL OR notification_lease_expires_at <= ${new Date(now).toISOString()})
          RETURNING number`;
          if (claimed.length) selected.push(pr);
        }
      }),
    );
    return { ...batch, pullRequests: selected };
  });
}

export function acknowledgePrHubNotifications(
  snapshot: PrHubSnapshot,
  input: PrHubAcknowledgeNotificationsInput,
  now = Date.now(),
) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (!snapshot.account || snapshot.account.generation !== input.accountGeneration) return;
    // An old batch may acknowledge only its captured version. A newer fingerprint
    // remains pending even when it arrived between delivery and acknowledgment.
    yield* sql`UPDATE pr_hub_viewer_state SET last_notified_fingerprint = notification_claimed_version,
      last_notified_at = ${new Date(now).toISOString()}, notification_lease_owner = NULL,
      notification_lease_expires_at = NULL, notification_claimed_version = NULL, notification_batch_id = NULL
      WHERE host = ${snapshot.host} AND viewer_id = ${String(snapshot.account.viewerId)}
        AND notification_lease_owner = ${input.clientId} AND notification_batch_id = ${input.batchId}
        AND notification_lease_expires_at > ${new Date(now).toISOString()}`;
  });
}
