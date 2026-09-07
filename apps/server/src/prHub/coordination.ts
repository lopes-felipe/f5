import { nextPrHubRefreshAt } from "./refreshSchedule.ts";
import { githubRequestScheduler } from "../git/githubRequestScheduler.ts";
import { withPrHubDiscoveryWork } from "./discoveryLease.ts";

import { GitHubCliError } from "../git/Errors.ts";
import { GitHubRequestPolicy } from "../git/githubRequestPolicy.ts";

import { GitHubCredentialScope } from "../git/githubApi.ts";

import { type PrHubRefreshInput, type PrHubSnapshot } from "@t3tools/contracts";

import { Cause, Effect, Exit, Option, Ref, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SourceControlProviderError } from "../sourceControl/SourceControlProvider.ts";

import {
  ReconcilePolicy,
  ViewerIdentity,
  asRecord,
  buildTrackedPullRequest,
  causeUserMessage,
  githubAuthState,
  stringValue,
} from "./discoveryModel.ts";

import type { ServerSettingsShape } from "../serverSettings.ts";
import type { createPrHubDiscovery } from "./discoveryRuntime.ts";
import type { createPrHubRepository } from "./repository.ts";
import type { PrHubDiscoveryMethods } from "./Services/PrHubDiscovery.ts";
export interface PrHubRefreshContext {
  readonly host: string;
  readonly repository: ReturnType<typeof createPrHubRepository>;
  readonly getSnapshot: Effect.Effect<PrHubSnapshot>;
  readonly resolveViewer: Effect.Effect<ViewerIdentity, SourceControlProviderError>;
  readonly fetchGraphql: ReturnType<typeof createPrHubDiscovery>["fetchGraphql"];
  readonly finishPrHubHydration: PrHubDiscoveryMethods["finishPrHubHydration"];
  readonly viewerRef: Ref.Ref<ViewerIdentity | null>;
}
export function createPrHubRefresh(
  context: PrHubRefreshContext & { settings: ServerSettingsShape; sql: SqlClient.SqlClient },
) {
  const {
    host,
    settings,
    sql,
    getSnapshot,
    resolveViewer,
    fetchGraphql,
    finishPrHubHydration,
    viewerRef,
  } = context;
  const {
    publishSnapshot,
    viewerStateMap,
    persistPullRequests,
    upsertRefreshState,
    hydrateSnapshot,
  } = context.repository;
  const publishRefreshSnapshot = (snapshot: PrHubSnapshot) =>
    Effect.gen(function* () {
      const currentSettings = yield* settings.getSettings.pipe(Effect.orDie);
      return yield* publishSnapshot({
        ...snapshot,
        nextRefreshAt: nextPrHubRefreshAt(
          { ...snapshot, nextRefreshAt: null },
          currentSettings.prHub.pollIntervalSeconds,
          githubRequestScheduler.status(host),
        ),
      });
    });
  const fetchAndPersist = (mode: PrHubRefreshInput["mode"]) =>
    Effect.gen(function* () {
      const currentSettings = yield* settings.getSettings.pipe(Effect.orDie);
      const intervalSeconds =
        currentSettings.prHub.pollIntervalSeconds === 0
          ? 0
          : Math.max(60, currentSettings.prHub.pollIntervalSeconds);
      if (mode === "if_stale") {
        if (intervalSeconds === 0) return yield* getSnapshot;
        const current = yield* getSnapshot;
        if (current.lastPolledAt) {
          const next = nextPrHubRefreshAt(
            current,
            intervalSeconds,
            githubRequestScheduler.status(host),
          );
          if (next && Date.parse(next) > Date.now()) return current;
        }
      }

      const viewerExit = yield* Effect.exit(resolveViewer);
      if (Exit.isFailure(viewerExit)) {
        const existing = yield* getSnapshot;
        const squashedError = Cause.squash(viewerExit.cause);
        const errorRecord = asRecord(squashedError);
        const kind = stringValue(errorRecord?.kind) ?? "generic";
        const message = causeUserMessage(viewerExit.cause, "Failed to resolve GitHub account.");
        const status =
          kind === "provider_missing"
            ? "gh_missing"
            : kind === "unauthenticated"
              ? "auth_required"
              : "error";
        const lastPolledAt = new Date().toISOString();
        const viewer = yield* Ref.get(viewerRef);
        if (viewer) {
          yield* upsertRefreshState({
            viewerId: String(viewer.context.viewerId),
            viewerLogin: viewer.login,
            status,
            lastPolledAt,
            lastSuccessAt: null,
            errorKind: kind,
            errorMessage: message,
          }).pipe(Effect.ignore);
        }
        const snapshot = {
          ...existing,
          lastPolledAt,
          status,
          host,
          errorKind: kind,
          errorMessage: message,
          authStates: [
            githubAuthState({
              host,
              viewerLogin: existing.viewerLogin,
              status,
              errorKind: kind,
              errorMessage: message,
            }),
          ],
        } satisfies PrHubSnapshot;
        return yield* publishRefreshSnapshot(snapshot);
      }

      const viewer = viewerExit.value;
      const scopeSignature = JSON.stringify(
        [...currentSettings.prHub.excludeRepos].map((repo) => repo.trim().toLowerCase()).sort(),
      );
      const scopeChanged = (value: { prHub: { excludeRepos: readonly string[] } }) =>
        JSON.stringify(
          [...value.prHub.excludeRepos].map((repo) => repo.trim().toLowerCase()).sort(),
        ) !== scopeSignature;
      const changedScope = () =>
        new GitHubCliError({
          operation: "prHub.discovery",
          kind: "forbidden",
          detail:
            "Monitoring exclusions changed. Queued work was invalidated and will resume with the new scope.",
        });
      const work = yield* withPrHubDiscoveryWork(
        { host, viewerId: String(viewer.context.viewerId) },
        "refresh",
        "monitoring",
        Effect.gen(function* () {
          const previousState = yield* viewerStateMap(String(viewer.context.viewerId));
          const alreadyPersisted = new Set<string>();
          const fetched = yield* fetchGraphql(viewer, mode === "force", (prs) =>
            Effect.gen(function* () {
              const latest = yield* settings.getSettings;
              const excluded = new Set(
                latest.prHub.excludeRepos.map((repo) => repo.trim().toLowerCase()),
              );
              const recovered = prs
                .filter((pr) => !excluded.has(pr.repository.nameWithOwner.toLowerCase()))
                .map((pr) =>
                  buildTrackedPullRequest(
                    pr,
                    viewer.login,
                    previousState.get(`${pr.repository.nameWithOwner}#${pr.number}`),
                  ),
                );
              yield* persistPullRequests(viewer, recovered, {
                reconcilePolicy: "terminal_only",
                skipReconciliation: true,
                excludedRepos: excluded,
              });
              for (const pr of recovered)
                alreadyPersisted.add(`${pr.repository.nameWithOwner}#${pr.number}`);
              const active = yield* Ref.get(viewerRef);
              if (active?.context.generation === viewer.context.generation && recovered.length > 0)
                yield* hydrateSnapshot(viewer).pipe(Effect.flatMap(publishSnapshot));
            }).pipe(Effect.orDie),
          ).pipe(Effect.provideService(GitHubCredentialScope, viewer.context));
          const latestSettings = yield* settings.getSettings;
          const excludeRepos = new Set(
            latestSettings.prHub.excludeRepos
              .map((repo) => repo.trim().toLowerCase())
              .filter(Boolean),
          );
          const tracked = fetched.pullRequests
            .filter((pr) => !excludeRepos.has(pr.repository.nameWithOwner.toLowerCase()))
            .map((pr) =>
              buildTrackedPullRequest(
                pr,
                viewer.login,
                previousState.get(`${pr.repository.nameWithOwner}#${pr.number}`),
              ),
            );
          const reconcilePolicy: ReconcilePolicy =
            fetched.degraded || fetched.cappedBuckets.length > 0
              ? "terminal_only"
              : "authoritative";
          yield* persistPullRequests(viewer, tracked, {
            reconcilePolicy,
            alreadyPersisted,
            excludedRepos: excludeRepos,
          }).pipe(Effect.provideService(GitHubCredentialScope, viewer.context));
          yield* finishPrHubHydration(
            { host, viewerId: String(viewer.context.viewerId) },
            tracked.flatMap((pr) => (pr.nodeId ? [pr.nodeId] : [])),
          ).pipe(Effect.provideService(SqlClient.SqlClient, sql));
          const now = new Date().toISOString();
          yield* upsertRefreshState({
            viewerId: String(viewer.context.viewerId),
            viewerLogin: viewer.login,
            status: fetched.degraded ? "degraded" : "ok",
            lastPolledAt: now,
            lastSuccessAt: fetched.degraded ? null : now,
            errorKind: fetched.degraded ? "degraded" : undefined,
            errorMessage: fetched.errorMessage,
            cappedBuckets: fetched.cappedBuckets,
            coverage: fetched.coverage,
          });
          const currentViewer = yield* Ref.get(viewerRef);
          if (currentViewer?.context.generation !== viewer.context.generation)
            return yield* getSnapshot;
          return yield* hydrateSnapshot(viewer).pipe(Effect.flatMap(publishRefreshSnapshot));
        }).pipe(
          Effect.provideService(GitHubRequestPolicy, {
            beforeSend: () =>
              settings.getSettings.pipe(
                Effect.mapError(() => changedScope()),
                Effect.flatMap((value) =>
                  scopeChanged(value) ? Effect.fail(changedScope()) : Effect.void,
                ),
              ),
            // Only an observed scope change invalidates a read. A settings stream that
            // simply ends must not cancel in-flight work with a misleading reason.
            readInvalidated: settings.streamChanges.pipe(
              Stream.filter(scopeChanged),
              Stream.runHead,
              Effect.flatMap((observed) =>
                Option.isSome(observed) ? Effect.fail(changedScope()) : Effect.never,
              ),
            ),
          }),
        ),
      ).pipe(Effect.provideService(SqlClient.SqlClient, sql));
      return Option.isSome(work) ? work.value : yield* getSnapshot;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const lastPolledAt = new Date().toISOString();
          const viewer = yield* Ref.get(viewerRef);
          if (viewer) {
            const message = causeUserMessage(cause, "PR Hub refresh failed.");
            yield* upsertRefreshState({
              viewerId: String(viewer.context.viewerId),
              viewerLogin: viewer.login,
              status: "error",
              lastPolledAt,
              lastSuccessAt: null,
              errorKind: "error",
              errorMessage: message,
            }).pipe(Effect.ignore);
          }
          const existing = yield* getSnapshot;
          const message = causeUserMessage(cause, "PR Hub refresh failed.");
          return yield* publishRefreshSnapshot({
            ...existing,
            lastPolledAt,
            status: "error",
            errorKind: "error",
            errorMessage: message,
            authStates: [
              githubAuthState({
                host,
                viewerLogin: existing.viewerLogin,
                status: "error",
                errorKind: "error",
                errorMessage: message,
              }),
            ],
          });
        }),
      ),
    );

  return fetchAndPersist;
}
