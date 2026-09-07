import { assertPrHubDiscoveryLease } from "./discoveryLease.ts";
import { unknownMergeRequirements } from "./mergeRequirements.ts";
import { createPrHubViewerActions, type PrHubViewerActionsContext } from "./viewerActions.ts";

import { protectedPrHubWork } from "./retention.ts";

import { defaultPrHubCoverage, excludePrHubRepositories, prHubInvalidation } from "./readModel.ts";

import {
  PrHubCoverage,
  type PrHubChanged,
  type PrHubSnapshot,
  type PrViewerRole,
  type TrackedPullRequest,
} from "@t3tools/contracts";
import { prAttentionText } from "@t3tools/shared/prHub";

import { Effect, PubSub, Ref, Schema, Semaphore } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  emptySnapshot,
  githubAuthState,
  githubProviderFields,
  isSnoozed,
  keyFor,
  NO_LONGER_RELEVANT_RETENTION_MS,
  parseJsonArray,
  parsePayload,
  PersistedPrRow,
  PrDbRow,
  ReconciledPrState,
  ReconcilePolicy,
  RefreshStateRow,
  repositoryFromNameWithOwner,
  RESOLVED_RETENTION_MS,
  sortTrackedPrs,
  terminalAttention,
  terminalFingerprint,
  ViewerIdentity,
  ViewerStateRow,
} from "./discoveryModel.ts";

import type { ServerSettingsShape } from "../serverSettings.ts";
export interface PrHubRepositoryContext {
  readonly host: string;
  readonly settings: ServerSettingsShape;
  readonly snapshotRef: Ref.Ref<PrHubSnapshot | null>;
  readonly viewerRef: Ref.Ref<ViewerIdentity | null>;
  readonly changePubSub: PubSub.PubSub<PrHubChanged>;
  readonly fetchReconciledPullRequestStates: (
    nodeIds: readonly string[],
  ) => Effect.Effect<ReadonlyMap<string, ReconciledPrState>>;
  readonly fetchReconciledPullRequestStatesByNumber: (
    rows: readonly Pick<PersistedPrRow, "repo" | "number">[],
  ) => Effect.Effect<ReadonlyMap<string, ReconciledPrState>>;
}
export function createPrHubRepository(
  context: PrHubRepositoryContext & { sql: SqlClient.SqlClient },
) {
  const {
    sql,
    host,
    settings,
    snapshotRef,
    viewerRef,
    changePubSub,
    fetchReconciledPullRequestStates,
    fetchReconciledPullRequestStatesByNumber,
  } = context;
  const providerKind = "github";
  let monitoringExclusions = new Set<string>();
  let monitoringScopeSignature = "[]";
  const publicationLock = Semaphore.makeUnsafe(1);
  const advancePublicationRevision = sql<{
    revision: number;
  }>`UPDATE pr_hub_publication SET revision = revision + 1 WHERE id = 1 RETURNING revision`;

  const publishSnapshot = (snapshot: PrHubSnapshot) =>
    Effect.gen(function* () {
      const previous = yield* Ref.get(snapshotRef);
      const currentSettings = yield* settings.getSettings;
      const excluded = new Set(
        currentSettings.prHub.excludeRepos.map((repo) => repo.trim().toLowerCase()),
      );
      const scopeSignature = JSON.stringify([...excluded].sort());
      const viewer = yield* Ref.get(viewerRef);
      if (snapshot.account && viewer && snapshot.account.generation !== viewer.context.generation)
        return excludePrHubRepositories(previous ?? emptySnapshot({ host }), excluded);
      const rows = yield* advancePublicationRevision;
      const published = { ...snapshot, revision: String(rows[0]!.revision) };
      yield* Ref.set(snapshotRef, published);
      const invalidation = prHubInvalidation(
        previous ? excludePrHubRepositories(previous, monitoringExclusions) : null,
        excludePrHubRepositories(published, excluded),
        published.revision,
      );
      yield* PubSub.publish(changePubSub, {
        ...invalidation,
        resyncRequired: invalidation.resyncRequired || scopeSignature !== monitoringScopeSignature,
      });
      monitoringExclusions = excluded;
      monitoringScopeSignature = scopeSignature;
      return excludePrHubRepositories(published, excluded);
    }).pipe(Effect.orDie, Effect.uninterruptible, publicationLock.withPermits(1));

  const loadRefreshState = (viewerId: string) =>
    sql<RefreshStateRow>`
    SELECT viewer_id, status, last_polled_at, error_kind, error_message, coverage_json
    FROM pr_hub_refresh_state WHERE provider_kind = ${providerKind} AND host = ${host} AND viewer_id = ${viewerId}
    LIMIT 1
  `.pipe(Effect.map((rows) => rows[0] ?? null));

  const viewerStateMap = (viewerLogin: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<ViewerStateRow & { readonly repo: string; readonly number: number }>`
        SELECT
          repo,
          number,
          roles_json,
          viewer_payload_json,
          attention_fingerprint,
          last_acknowledged_fingerprint,
          acknowledged_at,
          last_seen_fingerprint,
          last_notified_fingerprint,
          snoozed_until,
          ignored_at,
          no_longer_relevant_at
        FROM pr_hub_viewer_state
        WHERE provider_kind = ${providerKind}
          AND host = ${host}
          AND viewer_id = ${viewerLogin}
      `;
      return new Map(rows.map((row) => [`${row.repo}#${row.number}`, row] as const));
    });

  const hydrateSnapshot = (viewer: ViewerIdentity): Effect.Effect<PrHubSnapshot> =>
    Effect.gen(function* () {
      const refresh = yield* loadRefreshState(String(viewer.context.viewerId));
      const coverage = refresh?.coverage_json
        ? Schema.decodeUnknownSync(Schema.Array(PrHubCoverage))(JSON.parse(refresh.coverage_json))
        : undefined;
      const resolvedViewer = viewer.login;
      const unverified = yield* sql<{
        count: number;
      }>`SELECT count(*) AS count FROM pr_hub_viewer_state
        WHERE provider_kind = ${providerKind} AND host = ${host} AND viewer_id = ${String(viewer.context.viewerId)} AND facts_verified = 0`;
      const hasUnverifiedFacts = (unverified[0]?.count ?? 0) > 0;

      const rows = yield* sql<PrDbRow>`
        SELECT
          p.provider_kind,
          p.host,
          p.repo,
          p.number,
          p.node_id,
          p.title,
          p.url,
          p.author,
          p.state,
          p.draft,
          p.check_rollup,
          p.review_decision,
          p.mergeable,
          p.merge_state_status,
          p.additions,
          p.deletions,
          p.changed_files,
          p.created_at,
          p.updated_at,
          p.payload_json,
          v.viewer_payload_json,
          v.roles_json,
          v.attention_state,
          v.attention_bucket,
          v.primary_reason,
          v.next_action,
          v.attention_fingerprint,
          v.last_acknowledged_fingerprint,
          v.acknowledged_at,
          v.last_seen_fingerprint,
          v.last_notified_fingerprint,
          v.snoozed_until,
          v.ignored_at,
          v.no_longer_relevant_at
        FROM pr_hub_viewer_state v
        INNER JOIN pr_hub_prs p
          ON p.provider_kind = v.provider_kind
          AND p.host = v.host
          AND p.repo = v.repo
          AND p.number = v.number
        WHERE v.provider_kind = ${providerKind}
          AND v.host = ${host}
          AND v.viewer_id = ${String(viewer.context.viewerId)}
          AND v.facts_verified = 1
      `;

      const tracked = rows.map((row) => {
        const payload = {
          ...parsePayload(row.payload_json),
          ...parsePayload(row.viewer_payload_json),
        };
        const roles = parseJsonArray(row.roles_json) as PrViewerRole[];
        const fingerprint = row.attention_fingerprint;
        const snoozedUntil = row.snoozed_until;
        const ignoredAt = row.ignored_at;
        const notificationPending =
          payload.repositoryArchived !== true &&
          row.state === "open" &&
          row.attention_bucket === "needs_you" &&
          !isSnoozed(snoozedUntil) &&
          ignoredAt === null &&
          fingerprint !== row.last_notified_fingerprint &&
          fingerprint !== row.last_seen_fingerprint &&
          fingerprint !== row.last_acknowledged_fingerprint;
        return {
          ...payload,
          key: keyFor(row.host, row.repo, row.number),
          ...githubProviderFields({
            host: row.host,
            repository: row.repo,
            number: row.number,
            nodeId: row.node_id,
            reviewDecision: row.review_decision,
            mergeStateStatus: row.merge_state_status,
          }),
          nodeId: row.node_id,
          number: row.number,
          title: row.title,
          url: row.url,
          repository: repositoryFromNameWithOwner(row.repo),
          host: row.host,
          author: row.author,
          isDraft: row.draft === 1,
          state: row.state,
          roles,
          attentionState: row.attention_state,
          attentionBucket: row.attention_bucket,
          ...(payload.reasons?.[0]
            ? prAttentionText(payload.reasons[0].code, payload.actionableUnresolvedThreadCount ?? 0)
            : { primaryReason: row.primary_reason, nextAction: row.next_action }),
          checkRollup: row.check_rollup,
          reviewDecision: row.review_decision,
          mergeable: row.mergeable,
          mergeStateStatus: row.merge_state_status,
          viewerHasReviewed: payload.viewerHasReviewed ?? false,
          viewerReviewRequested: payload.viewerReviewRequested ?? false,
          reviewRequestReviewers: payload.reviewRequestReviewers ?? [],
          reviewRequestsCount: payload.reviewRequestsCount ?? 0,
          commentsCount: payload.commentsCount ?? 0,
          unresolvedThreadCount: payload.unresolvedThreadCount ?? 0,
          reviewFactsComplete: payload.reviewFactsComplete,
          reasonEvidenceTruncated: payload.reasonEvidenceTruncated,
          actionableUnresolvedThreadCount: payload.actionableUnresolvedThreadCount ?? 0,
          waitingSince: payload.waitingSince ?? null,
          lastVerifiedAt: payload.lastVerifiedAt ?? null,
          mergeRequirements: payload.mergeRequirements ?? unknownMergeRequirements(),
          additions: row.additions,
          deletions: row.deletions,
          changedFiles: row.changed_files,
          headRefOid: payload.headRefOid ?? null,
          baseRefName: payload.baseRefName ?? null,
          headRefName: payload.headRefName ?? null,
          labels: payload.labels ?? [],
          assignees: payload.assignees ?? [],
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          snoozedUntil,
          ignoredAt,
          acknowledgedAt:
            row.last_acknowledged_fingerprint === fingerprint
              ? (row.acknowledged_at ?? null)
              : null,
          notificationPending,
          attentionFingerprint: fingerprint,
        } satisfies TrackedPullRequest;
      });

      const pullRequests = tracked.filter(
        (pr) =>
          pr.state === "open" &&
          pr.ignoredAt === null &&
          rows.find((row) => row.repo === pr.repository.nameWithOwner && row.number === pr.number)
            ?.no_longer_relevant_at === null,
      );
      const recentlyResolved = tracked.filter(
        (pr) => pr.state === "closed" || pr.state === "merged" || pr.ignoredAt !== null,
      );
      return {
        status: hasUnverifiedFacts ? "degraded" : (refresh?.status ?? "ok"),
        account: viewer.context,
        viewerLogin: resolvedViewer,
        host,
        authStates: [
          githubAuthState({
            host,
            viewerLogin: resolvedViewer,
            status: refresh?.status ?? "ok",
            ...(refresh?.error_kind ? { errorKind: refresh.error_kind } : {}),
            ...(refresh?.error_message ? { errorMessage: refresh.error_message } : {}),
          }),
        ],
        pullRequests: sortTrackedPrs(pullRequests),
        recentlyResolved: sortTrackedPrs(recentlyResolved),
        lastPolledAt: refresh?.last_polled_at ?? null,
        ...(hasUnverifiedFacts
          ? {
              errorMessage:
                "Saved pull requests are awaiting account verification. Refresh to complete monitoring.",
            }
          : {}),
        ...(refresh?.error_kind ? { errorKind: refresh.error_kind } : {}),
        ...(refresh?.error_message ? { errorMessage: refresh.error_message } : {}),
        ...(coverage
          ? { coverage, cappedBuckets: coverage.flatMap((scope) => scope.limits ?? []) }
          : {}),
      } satisfies PrHubSnapshot;
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to hydrate PR Hub snapshot", {
          error: String(error),
        }).pipe(
          Effect.as(
            emptySnapshot({
              host,
              viewerLogin: viewer.login,
              status: "error",
              errorKind: "error",
              errorMessage: "Could not load persisted PR Hub data.",
            }),
          ),
        ),
      ),
    );

  const upsertRefreshState = (input: {
    readonly viewerId: string;
    readonly viewerLogin: string;
    readonly status: PrHubSnapshot["status"];
    readonly lastPolledAt: string | null;
    readonly lastSuccessAt: string | null;
    readonly errorKind?: string | undefined;
    readonly errorMessage?: string | undefined;
    readonly cappedBuckets?: ReadonlyArray<string> | undefined;
    readonly coverage?: PrHubSnapshot["coverage"];
  }) =>
    sql`
      INSERT INTO pr_hub_refresh_state (
        provider_kind,
        host,
        viewer_id,
        viewer_login,
        status,
        last_polled_at,
        last_success_at,
        error_kind,
        error_message,
        coverage_json
      )
      VALUES (
        ${providerKind},
        ${host},
        ${input.viewerId},
        ${input.viewerLogin},
        ${input.status},
        ${input.lastPolledAt},
        ${input.lastSuccessAt},
        ${input.errorKind ?? null},
        ${input.errorMessage ?? null},
        ${JSON.stringify(input.coverage ?? defaultPrHubCoverage(input.lastPolledAt, input.cappedBuckets))}
      )
      ON CONFLICT (provider_kind, host, viewer_id)
      DO UPDATE SET
        provider_kind = excluded.provider_kind,
        status = excluded.status,
        last_polled_at = excluded.last_polled_at,
        last_success_at = COALESCE(excluded.last_success_at, pr_hub_refresh_state.last_success_at),
        error_kind = excluded.error_kind,
        error_message = excluded.error_message,
        coverage_json = excluded.coverage_json
    `;

  const persistPullRequests = (
    viewer: ViewerIdentity,
    pullRequests: ReadonlyArray<TrackedPullRequest>,
    options: {
      readonly skipReconciliation?: boolean;
      readonly reconcilePolicy: ReconcilePolicy;
      readonly excludedRepos: ReadonlySet<string>;
    },
  ) =>
    Effect.gen(function* () {
      const now = new Date().toISOString();
      const seenKeys = new Set(
        pullRequests.map((pr) => `${pr.repository.nameWithOwner}#${pr.number}`),
      );
      const initialDiscovery = (yield* loadRefreshState(String(viewer.context.viewerId))) === null;
      for (const pr of pullRequests) {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* assertPrHubDiscoveryLease.pipe(Effect.provideService(SqlClient.SqlClient, sql));
            yield* sql`
          INSERT INTO pr_hub_prs (
            provider_kind,
            host,
            repo,
            number,
            node_id,
            title,
            url,
            author,
            state,
            draft,
            check_rollup,
            review_decision,
            mergeable,
            merge_state_status,
            additions,
            deletions,
            changed_files,
            created_at,
            updated_at,
            closed_at,
            payload_json
          )
          VALUES (
            ${pr.provider},
            ${pr.host},
            ${pr.repository.nameWithOwner},
            ${pr.number},
            ${pr.nodeId},
            ${pr.title},
            ${pr.url},
            ${pr.author},
            ${pr.state},
            ${pr.isDraft ? 1 : 0},
            ${pr.checkRollup},
            ${pr.reviewDecision},
            ${pr.mergeable},
            ${pr.mergeStateStatus},
            ${pr.additions},
            ${pr.deletions},
            ${pr.changedFiles},
            ${pr.createdAt},
            ${pr.updatedAt},
            ${pr.state === "open" ? null : pr.updatedAt},
            ${JSON.stringify({
              repositoryArchived: pr.repositoryArchived,
              headRefOid: pr.headRefOid,
              baseRefName: pr.baseRefName,
              headRefName: pr.headRefName,
              labels: pr.labels,
              assignees: pr.assignees,
              commentsCount: pr.commentsCount,
              unresolvedThreadCount: pr.unresolvedThreadCount,
              reviewRequestReviewers: pr.reviewRequestReviewers,
              reviewRequestsCount: pr.reviewRequestsCount,
            })}
          )
          ON CONFLICT (provider_kind, host, repo, number)
          DO UPDATE SET
            provider_kind = excluded.provider_kind,
            title = excluded.title,
            node_id = excluded.node_id,
            url = excluded.url,
            author = excluded.author,
            state = excluded.state,
            draft = excluded.draft,
            check_rollup = excluded.check_rollup,
            review_decision = excluded.review_decision,
            mergeable = excluded.mergeable,
            merge_state_status = excluded.merge_state_status,
            additions = excluded.additions,
            deletions = excluded.deletions,
            changed_files = excluded.changed_files,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            closed_at = excluded.closed_at,
            payload_json = excluded.payload_json
        `;
            yield* sql`
          INSERT INTO pr_hub_viewer_state (
            provider_kind,
            host,
            viewer_id,
            viewer_login,
            viewer_payload_json,
            facts_verified,
            repo,
            number,
            roles_json,
            attention_state,
            attention_bucket,
            primary_reason,
            next_action,
            sort_timestamp,
            attention_fingerprint,
            attention_model_version,
            last_seen_fingerprint,
            last_notified_fingerprint,
            last_notified_at,
            snoozed_until,
            ignored_at,
            last_matched_at,
            no_longer_relevant_at,
            stale_inaccessible_count,
            stale_inaccessible_at
          )
          VALUES (
            ${pr.provider},
            ${pr.host},
            ${String(viewer.context.viewerId)},
            ${viewer.login},
            ${JSON.stringify({
              lastReconciledAt: now,
              reasons: pr.reasons,
              manuallyTracked: pr.manuallyTracked,
              mergeRequirements: pr.mergeRequirements,
              mergePermission: pr.mergePermission,
              lastVerifiedAt: pr.lastVerifiedAt,
              viewerHasReviewed: pr.viewerHasReviewed,
              viewerReviewRequested: pr.viewerReviewRequested,
              waitingSince: pr.waitingSince,
              reasonEvidenceTruncated: pr.reasonEvidenceTruncated,
              reviewFactsComplete: pr.reviewFactsComplete,
              actionableUnresolvedThreadCount: pr.actionableUnresolvedThreadCount,
            })},
            ${1},
            ${pr.repository.nameWithOwner},
            ${pr.number},
            ${JSON.stringify(pr.roles)},
            ${pr.attentionState},
            ${pr.attentionBucket},
            ${pr.primaryReason},
            ${pr.nextAction},
            ${pr.updatedAt},
            ${pr.attentionFingerprint},
            ${2},
            ${initialDiscovery ? pr.attentionFingerprint : null},
            ${null},
            ${null},
            ${pr.snoozedUntil},
            ${pr.ignoredAt},
            ${now},
            ${null},
            ${0},
            ${null}
          )
          ON CONFLICT (provider_kind, host, viewer_id, repo, number)
          DO UPDATE SET
            last_seen_fingerprint = CASE
              WHEN pr_hub_viewer_state.attention_model_version < 2 AND (
                pr_hub_viewer_state.attention_bucket <> 'needs_you' OR
                pr_hub_viewer_state.last_seen_fingerprint = pr_hub_viewer_state.attention_fingerprint OR
                pr_hub_viewer_state.last_notified_fingerprint = pr_hub_viewer_state.attention_fingerprint
              ) THEN excluded.attention_fingerprint
              ELSE pr_hub_viewer_state.last_seen_fingerprint END,
            attention_model_version = 2,
            viewer_login = excluded.viewer_login,
            viewer_payload_json = excluded.viewer_payload_json,
            facts_verified = excluded.facts_verified,
            provider_kind = excluded.provider_kind,
            roles_json = excluded.roles_json,
            attention_state = excluded.attention_state,
            attention_bucket = excluded.attention_bucket,
            primary_reason = excluded.primary_reason,
            next_action = excluded.next_action,
            sort_timestamp = excluded.sort_timestamp,
            attention_fingerprint = excluded.attention_fingerprint,
            snoozed_until = COALESCE(pr_hub_viewer_state.snoozed_until, excluded.snoozed_until),
            ignored_at = pr_hub_viewer_state.ignored_at,
            last_matched_at = excluded.last_matched_at,
            no_longer_relevant_at = NULL,
            stale_inaccessible_count = 0,
            stale_inaccessible_at = NULL
        `;
            // Facts, viewer attention and their durable revision commit together, even if
            // the process stops before the corresponding invalidation is broadcast.
            yield* advancePublicationRevision;
          }),
        );
      }

      if (options.skipReconciliation) return;

      const applyTerminalState = (row: PersistedPrRow, terminal: ReconciledPrState) =>
        Effect.gen(function* () {
          const attention = terminalAttention(terminal.state);
          const fingerprint = terminalFingerprint({
            host,
            repo: row.repo,
            number: row.number,
            state: terminal.state,
            updatedAt: terminal.updatedAt,
          });
          const payload = parsePayload(row.payload_json);
          const nextPayload = JSON.stringify({
            ...payload,
            nodeId: terminal.nodeId ?? row.node_id,
            state: terminal.state,
            updatedAt: terminal.updatedAt,
          });
          yield* sql`
            UPDATE pr_hub_prs
            SET
              node_id = ${terminal.nodeId ?? row.node_id},
              state = ${terminal.state},
              updated_at = ${terminal.updatedAt},
              closed_at = ${terminal.closedAt},
              payload_json = ${nextPayload}
            WHERE provider_kind = ${providerKind}
              AND host = ${host}
              AND repo = ${row.repo}
              AND number = ${row.number}
          `;
          yield* sql`
            UPDATE pr_hub_viewer_state
            SET
              viewer_payload_json = json_remove(viewer_payload_json, '$.reasons'),
              attention_state = ${attention.attentionState},
              attention_bucket = ${attention.attentionBucket},
              primary_reason = ${attention.primaryReason},
              next_action = ${attention.nextAction},
              sort_timestamp = ${terminal.updatedAt},
              attention_fingerprint = ${fingerprint},
              last_matched_at = ${now},
              no_longer_relevant_at = NULL,
              stale_inaccessible_count = 0,
              stale_inaccessible_at = NULL
            WHERE provider_kind = ${providerKind}
              AND host = ${host}
              AND viewer_id = ${String(viewer.context.viewerId)}
              AND repo = ${row.repo}
              AND number = ${row.number}
          `;
          yield* advancePublicationRevision;
        });

      const budgetRows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM pr_hub_sync_tasks
        WHERE provider_kind = ${providerKind} AND host = ${host} AND viewer_id = ${String(viewer.context.viewerId)} AND kind = 'budget' AND task_key = 'reconciliation'`;
      const previousBudget = budgetRows[0]
        ? (JSON.parse(budgetRows[0].payload_json) as { start: number; used: number })
        : null;
      const reconcileBudget =
        previousBudget && Date.now() - previousBudget.start < 180_000
          ? previousBudget
          : { start: Date.now(), used: 0 };
      const remainingReconciliations = Math.max(0, 60 - reconcileBudget.used);
      const existing = yield* sql<PersistedPrRow>`
        SELECT
          v.repo,
          v.number,
          p.node_id,
          v.stale_inaccessible_count,
          p.payload_json
        FROM pr_hub_viewer_state v
        INNER JOIN pr_hub_prs p
          ON p.provider_kind = v.provider_kind
          AND p.host = v.host
          AND p.repo = v.repo
          AND p.number = v.number
        WHERE v.provider_kind = ${providerKind}
          AND v.host = ${host}
          AND v.viewer_id = ${String(viewer.context.viewerId)}
          AND v.no_longer_relevant_at IS NULL
          AND lower(v.repo) NOT IN (SELECT value FROM json_each(${JSON.stringify([...options.excludedRepos])}))
          AND (v.repo || '#' || v.number) NOT IN (SELECT value FROM json_each(${JSON.stringify([...seenKeys])}))
        ORDER BY COALESCE(json_extract(v.viewer_payload_json, '$.lastReconciledAt'), ''), v.repo, v.number
        LIMIT ${remainingReconciliations}
      `;
      // Exclusion controls monitoring, not retention. Provider facts are shared
      // across viewers, and account preferences must survive removing a filter.
      const missingRows = existing.filter(
        (row) =>
          !options.excludedRepos.has(row.repo.toLowerCase()) &&
          !seenKeys.has(`${row.repo}#${row.number}`),
      );
      yield* sql`INSERT INTO pr_hub_sync_tasks(provider_kind, host, viewer_id, kind, task_key, payload_json, created_at, updated_at)
        VALUES (${providerKind}, ${host}, ${String(viewer.context.viewerId)}, 'budget', 'reconciliation', ${JSON.stringify({ start: reconcileBudget.start, used: reconcileBudget.used + missingRows.length })}, ${now}, ${now})
        ON CONFLICT(provider_kind, host, viewer_id, kind, task_key) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`;
      for (const row of missingRows)
        yield* sql`UPDATE pr_hub_viewer_state SET viewer_payload_json = json_set(viewer_payload_json, '$.lastReconciledAt', ${now})
          WHERE provider_kind = ${providerKind} AND host = ${host} AND viewer_id = ${String(viewer.context.viewerId)} AND repo = ${row.repo} AND number = ${row.number}`;
      const terminalByNodeId = yield* fetchReconciledPullRequestStates(
        missingRows.map((row) => row.node_id).filter((nodeId): nodeId is string => nodeId !== null),
      );
      const terminalByKey = yield* fetchReconciledPullRequestStatesByNumber(
        missingRows.filter((row) => row.node_id === null),
      );
      for (const row of missingRows) {
        const terminal = row.node_id
          ? terminalByNodeId.get(row.node_id)
          : terminalByKey.get(`${row.repo}#${row.number}`);
        if (terminal) {
          yield* sql.withTransaction(applyTerminalState(row, terminal));
          continue;
        }
        if (options.reconcilePolicy === "terminal_only") continue;
        // Search absence and an inaccessible direct read are not evidence that
        // this PR stopped being relevant. Retain it with its last verified facts.
        const nextMissCount = row.stale_inaccessible_count + 1;
        yield* sql`
          UPDATE pr_hub_viewer_state
          SET
            stale_inaccessible_count = ${nextMissCount},
            stale_inaccessible_at = ${now}
          WHERE provider_kind = ${providerKind}
            AND host = ${host}
            AND viewer_id = ${String(viewer.context.viewerId)}
            AND repo = ${row.repo}
            AND number = ${row.number}
        `;
      }
      const resolvedBefore = new Date(Date.now() - RESOLVED_RETENTION_MS).toISOString();
      const irrelevantBefore = new Date(Date.now() - NO_LONGER_RELEVANT_RETENTION_MS).toISOString();
      const protectedWork = protectedPrHubWork(sql);
      yield* sql`
        WITH protected_prs AS (${protectedWork})
        DELETE FROM pr_hub_viewer_state
        WHERE provider_kind = ${providerKind} AND host = ${host} AND viewer_id = ${String(viewer.context.viewerId)}
          AND no_longer_relevant_at IS NOT NULL AND no_longer_relevant_at < ${irrelevantBefore}
          AND NOT EXISTS (SELECT 1 FROM protected_prs p WHERE p.provider_kind = pr_hub_viewer_state.provider_kind
            AND p.host = pr_hub_viewer_state.host AND p.viewer_id = pr_hub_viewer_state.viewer_id
            AND p.repo = pr_hub_viewer_state.repo AND p.number = pr_hub_viewer_state.number)`;
      yield* sql`
        WITH protected_prs AS (${protectedWork})
        DELETE FROM pr_hub_prs
        WHERE provider_kind = ${providerKind} AND host = ${host} AND state IN ('closed', 'merged')
          AND closed_at IS NOT NULL AND closed_at < ${resolvedBefore}
          AND NOT EXISTS (SELECT 1 FROM protected_prs p WHERE p.provider_kind = pr_hub_prs.provider_kind
            AND p.host = pr_hub_prs.host AND p.repo = pr_hub_prs.repo AND p.number = pr_hub_prs.number)`;
    });

  return {
    publishSnapshot,
    loadRefreshState,
    viewerStateMap,
    hydrateSnapshot,
    upsertRefreshState,
    persistPullRequests,
    advancePublicationRevision,
    scopeSignature: () => monitoringScopeSignature,
    createViewerActions: (context: PrHubViewerActionsContext) =>
      createPrHubViewerActions({
        ...context,
        sql,
        host,
        snapshotRef,
        viewerRef,
        hydrateSnapshot,
        publishSnapshot,
        advancePublicationRevision,
      }),
  };
}
