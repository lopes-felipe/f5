import type { SqlError } from "effect/unstable/sql/SqlError";

import { protectedPrHubWork } from "./retention.ts";

import { acknowledgePrHubNotifications, claimPrHubNotifications } from "./notificationLeases.ts";

import { PullRequestKey, type PrHubSnapshot, type TrackedPullRequest } from "@t3tools/contracts";

import {
  parseSourceControlPullRequestKey,
  sourceControlPullRequestKeysEqual,
} from "@t3tools/shared/sourceControl";
import { Effect, Ref } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SourceControlProviderError } from "../sourceControl/SourceControlProvider.ts";
import { type PrHubServiceShape } from "./Services/PrHubService.ts";

import { ViewerIdentity } from "./discoveryModel.ts";

import { persistPrHubState, prHubActionError } from "./errors.ts";
export interface PrHubViewerActionsContext {
  readonly getSnapshot: Effect.Effect<PrHubSnapshot>;
  readonly resolveViewer: Effect.Effect<ViewerIdentity, SourceControlProviderError>;
  readonly clearCaches: () => void;
}
interface Owner {
  sql: SqlClient.SqlClient;
  host: string;
  snapshotRef: Ref.Ref<PrHubSnapshot | null>;
  viewerRef: Ref.Ref<ViewerIdentity | null>;
  hydrateSnapshot: (viewer: ViewerIdentity) => Effect.Effect<PrHubSnapshot>;
  publishSnapshot: (snapshot: PrHubSnapshot) => Effect.Effect<PrHubSnapshot>;
  advancePublicationRevision: Effect.Effect<unknown, SqlError>;
}
export function createPrHubViewerActions(context: PrHubViewerActionsContext & Owner) {
  const {
    sql,
    host,
    snapshotRef,
    viewerRef,
    hydrateSnapshot,
    publishSnapshot,
    advancePublicationRevision,
    getSnapshot,
    resolveViewer,
    clearCaches,
  } = context;
  const providerKind = "github";
  const mutateLocalState = (
    key: PullRequestKey,
    update: (current: TrackedPullRequest) => Partial<TrackedPullRequest>,
  ) =>
    Ref.get(snapshotRef).pipe(
      Effect.flatMap((snapshot) => {
        if (!snapshot) return getSnapshot;
        const mapPr = (pr: TrackedPullRequest): TrackedPullRequest =>
          sourceControlPullRequestKeysEqual(pr.key, key) ? { ...pr, ...update(pr) } : pr;
        return publishSnapshot({
          ...snapshot,
          pullRequests: snapshot.pullRequests.map(mapPr),
          recentlyResolved: snapshot.recentlyResolved.map(mapPr),
        });
      }),
    );

  const acknowledgeAttention: PrHubServiceShape["acknowledgeAttention"] = (input) =>
    Effect.gen(function* () {
      const parsed = parseSourceControlPullRequestKey(input.key);
      const snapshot = yield* getSnapshot;
      if (!parsed || !snapshot.account || snapshot.account.generation !== input.accountGeneration)
        return yield* prHubActionError("The GitHub account changed. Refresh before acknowledging.");
      const at = new Date().toISOString();
      const rows = yield* sql<{ number: number }>`UPDATE pr_hub_viewer_state
        SET last_acknowledged_fingerprint = ${input.attentionFingerprint}, acknowledged_at = ${at}
        WHERE provider_kind = ${parsed.provider} AND host = ${parsed.host}
          AND viewer_id = ${String(snapshot.account.viewerId)} AND repo = ${parsed.repository} AND number = ${parsed.number}
          AND attention_fingerprint = ${input.attentionFingerprint} RETURNING number`.pipe(
        persistPrHubState("prHub.acknowledgeAttention"),
      );
      if (!rows.length)
        return yield* prHubActionError("The PR attention changed. Reload before acknowledging.");
      return yield* mutateLocalState(input.key, (pr) =>
        pr.attentionFingerprint === input.attentionFingerprint
          ? { acknowledgedAt: at, notificationPending: false }
          : {},
      );
    });

  const markSeen: PrHubServiceShape["markSeen"] = (input) =>
    Effect.gen(function* () {
      const parsed = parseSourceControlPullRequestKey(input.key);
      const snapshot = yield* getSnapshot;
      const viewerLogin = snapshot.account ? String(snapshot.account.viewerId) : null;
      if (!parsed || !viewerLogin) return snapshot;
      yield* sql`
        UPDATE pr_hub_viewer_state
        SET last_seen_fingerprint = ${input.attentionFingerprint}
        WHERE provider_kind = ${parsed.provider}
          AND host = ${parsed.host}
          AND viewer_id = ${viewerLogin}
          AND repo = ${parsed.repository}
          AND number = ${parsed.number}
          AND attention_fingerprint = ${input.attentionFingerprint}
      `.pipe(persistPrHubState("prHub.markSeen"));
      return yield* mutateLocalState(input.key, (pr) =>
        pr.attentionFingerprint === input.attentionFingerprint
          ? { notificationPending: false }
          : {},
      );
    });

  const markNotified: PrHubServiceShape["markNotified"] = (input) =>
    Effect.gen(function* () {
      const parsed = parseSourceControlPullRequestKey(input.key);
      const snapshot = yield* getSnapshot;
      const viewerLogin = snapshot.account ? String(snapshot.account.viewerId) : null;
      if (!parsed || !viewerLogin) return snapshot;
      yield* sql`
        UPDATE pr_hub_viewer_state
        SET
          last_notified_fingerprint = ${input.attentionFingerprint},
          last_notified_at = ${new Date().toISOString()}
        WHERE provider_kind = ${parsed.provider}
          AND host = ${parsed.host}
          AND viewer_id = ${viewerLogin}
          AND repo = ${parsed.repository}
          AND number = ${parsed.number}
          AND attention_fingerprint = ${input.attentionFingerprint}
      `.pipe(persistPrHubState("prHub.markNotified"));
      return yield* mutateLocalState(input.key, (pr) =>
        pr.attentionFingerprint === input.attentionFingerprint
          ? { notificationPending: false }
          : {},
      );
    });

  const snooze: PrHubServiceShape["snooze"] = (input) =>
    Effect.gen(function* () {
      const parsed = parseSourceControlPullRequestKey(input.key);
      const snapshot = yield* getSnapshot;
      const viewerLogin = snapshot.account ? String(snapshot.account.viewerId) : null;
      if (!parsed || !viewerLogin) return snapshot;
      yield* sql`
        UPDATE pr_hub_viewer_state
        SET snoozed_until = ${input.until}
        WHERE provider_kind = ${parsed.provider}
          AND host = ${parsed.host}
          AND viewer_id = ${viewerLogin}
          AND repo = ${parsed.repository}
          AND number = ${parsed.number}
      `.pipe(persistPrHubState("prHub.snooze"));
      return yield* mutateLocalState(input.key, () => ({
        snoozedUntil: input.until,
        notificationPending: false,
      }));
    });

  const unsnooze: PrHubServiceShape["unsnooze"] = (input) =>
    Effect.gen(function* () {
      const parsed = parseSourceControlPullRequestKey(input.key);
      const snapshot = yield* getSnapshot;
      const viewerLogin = snapshot.account ? String(snapshot.account.viewerId) : null;
      if (!parsed || !viewerLogin) return snapshot;
      yield* sql`
        UPDATE pr_hub_viewer_state
        SET snoozed_until = NULL
        WHERE provider_kind = ${parsed.provider}
          AND host = ${parsed.host}
          AND viewer_id = ${viewerLogin}
          AND repo = ${parsed.repository}
          AND number = ${parsed.number}
      `.pipe(persistPrHubState("prHub.unsnooze"));
      return yield* resolveViewer.pipe(
        Effect.flatMap(hydrateSnapshot),
        Effect.flatMap(publishSnapshot),
      );
    });

  const ignore: PrHubServiceShape["ignore"] = (input) =>
    Effect.gen(function* () {
      const parsed = parseSourceControlPullRequestKey(input.key);
      const snapshot = yield* getSnapshot;
      const viewerLogin = snapshot.account ? String(snapshot.account.viewerId) : null;
      if (!parsed || !viewerLogin) return snapshot;
      const ignoredAt = new Date().toISOString();
      yield* sql`
        UPDATE pr_hub_viewer_state
        SET
          ignored_at = ${ignoredAt},
          last_seen_fingerprint = attention_fingerprint
        WHERE provider_kind = ${parsed.provider}
          AND host = ${parsed.host}
          AND viewer_id = ${viewerLogin}
          AND repo = ${parsed.repository}
          AND number = ${parsed.number}
      `.pipe(persistPrHubState("prHub.ignore"));
      return yield* resolveViewer.pipe(
        Effect.flatMap(hydrateSnapshot),
        Effect.flatMap(publishSnapshot),
      );
    });

  const clearData: PrHubServiceShape["clearData"] = () =>
    Effect.gen(function* () {
      const viewer = yield* Ref.get(viewerRef);
      if (!viewer) return yield* prHubActionError("A verified account is required.");
      const viewerId = String(viewer.context.viewerId);
      const protectedWork = protectedPrHubWork(sql);
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM pr_hub_advisories WHERE provider_kind = ${providerKind} AND host = ${host} AND viewer_id = ${viewerId}`;
            yield* sql`WITH protected_prs AS (${protectedWork}) DELETE FROM pr_hub_viewer_state
          WHERE provider_kind = ${providerKind} AND host = ${host} AND viewer_id = ${viewerId}
            AND NOT EXISTS (SELECT 1 FROM protected_prs p WHERE p.provider_kind = pr_hub_viewer_state.provider_kind
              AND p.host = pr_hub_viewer_state.host AND p.viewer_id = pr_hub_viewer_state.viewer_id
              AND p.repo = pr_hub_viewer_state.repo AND p.number = pr_hub_viewer_state.number)`;
            yield* sql`DELETE FROM pr_hub_connection_facts WHERE provider_kind=${providerKind} AND host=${host} AND viewer_id=${viewerId}`;
            yield* sql`DELETE FROM pr_hub_repository_provenance WHERE provider_kind=${providerKind} AND host=${host} AND viewer_id=${viewerId}`;
            yield* sql`DELETE FROM pr_hub_refresh_state WHERE provider_kind = ${providerKind} AND host = ${host} AND viewer_id = ${viewerId}`;
            yield* sql`DELETE FROM pr_hub_sync_tasks WHERE provider_kind = ${providerKind} AND host = ${host} AND viewer_id = ${viewerId} AND kind NOT IN ('budget', 'membership')`;
            yield* advancePublicationRevision;
          }),
        )
        .pipe(persistPrHubState("prHub.clearData"));
      clearCaches();
      return yield* hydrateSnapshot(viewer).pipe(Effect.flatMap(publishSnapshot));
    });

  const claimNotifications: PrHubServiceShape["claimNotifications"] = (input) =>
    getSnapshot.pipe(
      Effect.flatMap((snapshot) =>
        claimPrHubNotifications(snapshot, input).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        ),
      ),
      persistPrHubState("prHub.claimNotifications"),
    );
  const acknowledgeNotifications: PrHubServiceShape["acknowledgeNotifications"] = (input) =>
    Effect.gen(function* () {
      const snapshot = yield* getSnapshot;
      yield* acknowledgePrHubNotifications(snapshot, input).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        persistPrHubState("prHub.acknowledgeNotifications"),
      );
      const viewer = yield* Ref.get(viewerRef);
      return viewer
        ? yield* hydrateSnapshot(viewer).pipe(Effect.flatMap(publishSnapshot))
        : snapshot;
    });

  return {
    acknowledgeAttention,
    markSeen,
    markNotified,
    snooze,
    unsnooze,
    ignore,
    clearData,
    claimNotifications,
    acknowledgeNotifications,
  };
}
