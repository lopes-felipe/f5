import { Effect, Option, PubSub, Schema, Semaphore, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  TrackedPullRequest,
  PrHubDetailResult,
  PrHubFilesPage,
  PrHubTimelinePage,
  PrHubComparisonIdentity,
  type ForgeAccount,
  type PrHubChanged,
  type PrHubSnapshot,
  type PrHubReviewThread,
  type SourceControlPullRequestRef,
} from "@t3tools/contracts";
import {
  parseSourceControlPullRequestKey,
  parseSourceControlPullRequestUrl,
} from "@t3tools/shared/sourceControl";
import type { ForgeDetail, ForgeProvider } from "../sourceControl/ForgeSourceControlProvider.ts";
import { SourceControlProviderError } from "../sourceControl/SourceControlProvider.ts";
import { ForgeAccounts } from "../sourceControl/accountRouting.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { resolveLocalCheckout } from "./localCheckout.ts";
import type { PrHubServiceShape } from "./Services/PrHubService.ts";
import {
  forgeDetail,
  forgeTracked,
  forgeReviewThreads,
  forgeComparison,
  forgeUserMatches,
  record,
  text,
  login,
} from "./forgeModel.ts";
import { listPrHubPullRequests, prHubInvalidation, prHubOverview } from "./readModel.ts";

const PAGE_INFO = { hasNextPage: false, endCursor: null, truncated: false } as const;
const MAX_TRACKED = 500;
const CACHE_MS = 60_000;
interface Stored {
  generation: string;
  pr: TrackedPullRequest;
  detail: PrHubDetailResult;
  comparison?: PrHubComparisonIdentity;
}
interface Cached<A> {
  readonly value?: A;
  readonly attemptedAt: number;
  readonly failed: boolean;
  readonly error?: SourceControlProviderError;
}

/** One immutable account generation owns each service, cache and durable row namespace. */
export const makeForgePrHubService = (account: ForgeAccount, provider: ForgeProvider) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient,
      settings = yield* ServerSettingsService,
      scope = yield* Effect.scope;
    const accounts = yield* Effect.serviceOption(ForgeAccounts),
      projects = yield* Effect.serviceOption(ProjectionProjectRepository);
    const changes = yield* PubSub.sliding<PrHubChanged>(32),
      gate = yield* Semaphore.make(1);
    const state = new Map<string, Stored>(),
      filesCache = new Map<string, Cached<PrHubFilesPage>>(),
      timelineCache = new Map<string, Cached<PrHubTimelinePage>>(),
      detailAttempts = new Map<string, number>();
    const pendingTracked = new Set<string>();
    const detailErrors = new Map<string, SourceControlProviderError>();
    const threadsCache = new Map<string, Cached<readonly PrHubReviewThread[]>>();
    let revision = 0,
      lastAttempt = 0,
      lastPolledAt: string | null = null,
      monitoring = false;
    let status: PrHubSnapshot["status"] = "ok",
      warning: string | undefined;
    const error = (detail: string, kind: SourceControlProviderError["kind"] = "unsupported") =>
      new SourceControlProviderError({
        provider: account.provider,
        host: account.host,
        operation: "prHub",
        detail,
        kind,
      });
    const unsupported = () =>
      Effect.fail(error("This operation uses the provider-specific PR Hub action workflow."));
    const assertGeneration = (generation?: string) =>
      Effect.gen(function* () {
        if (generation !== undefined && generation !== account.generation)
          return yield* error(
            "The account changed. Refresh PR Hub before continuing.",
            "forbidden",
          );
        if (Option.isSome(accounts)) {
          const current = (yield* accounts.value.listAccounts()).find(
            (value) => value.id === account.id,
          );
          if (!current || current.generation !== account.generation)
            return yield* error(
              "The account credentials changed. Refresh PR Hub before continuing.",
              "unauthenticated",
            );
        }
      });
    const refFor = (key: string, generation?: string) =>
      Effect.gen(function* () {
        yield* assertGeneration(generation);
        const ref = parseSourceControlPullRequestKey(key);
        if (
          !ref ||
          ref.provider !== account.provider ||
          ref.host.toLowerCase() !== account.host.toLowerCase()
        )
          return yield* error("Pull request does not belong to this forge account.", "forbidden");
        if (Option.isSome(accounts) && (yield* accounts.value.route(ref)).id !== account.id)
          return yield* error("Repository is routed to a different account.", "forbidden");
        return ref;
      });
    const snapshot = (): PrHubSnapshot => ({
      status,
      viewerLogin: account.login,
      host: account.host,
      account: {
        host: account.host,
        login: account.login,
        viewerId: account.viewerId,
        generation: account.generation,
      },
      revision: String(revision),
      pullRequests: [...state.values()]
        .map((value) => value.pr)
        .filter((pr) => pr.state === "open"),
      recentlyResolved: [...state.values()]
        .map((value) => value.pr)
        .filter((pr) => pr.state !== "open"),
      lastPolledAt,
      nextRefreshAt: lastAttempt ? new Date(lastAttempt + 180_000).toISOString() : null,
      coverage: [
        {
          scope: "known_repositories",
          status: lastPolledAt ? "partial" : "not_scanned",
          description:
            "Discovery covers explicitly routed repositories; provider pages may be capped.",
        },
        {
          scope: "previously_tracked",
          status: lastPolledAt ? "partial" : "not_scanned",
          description:
            "Manually tracked requests retain their last verified state during failures.",
        },
      ],
      ...(warning ? { errorMessage: warning, errorKind: "network" } : {}),
    });
    const publish = (previous: PrHubSnapshot) =>
      Effect.gen(function* () {
        revision++;
        yield* PubSub.publish(changes, {
          ...prHubInvalidation(previous, snapshot(), String(revision)),
          resyncRequired: true,
        });
      });
    const persist = (stored: Stored) =>
      sql`INSERT INTO forge_pr_hub_state (account_id,pr_key,data_json) VALUES (${account.id},${stored.pr.key},${JSON.stringify(stored)}) ON CONFLICT(account_id,pr_key) DO UPDATE SET data_json=excluded.data_json`.pipe(
        Effect.mapError(() => error("Could not persist the pull request snapshot.", "generic")),
      );
    const rows = yield* sql<{
      data_json: string;
    }>`SELECT data_json FROM forge_pr_hub_state WHERE account_id=${account.id} LIMIT ${MAX_TRACKED}`.pipe(
      Effect.catch(() => Effect.succeed([])),
    );
    for (const row of rows) {
      const stored = decodeStored(row.data_json, account);
      if (stored) state.set(stored.pr.key, stored);
      else {
        // A credential rotation retains the tracked reference but requires a fresh read of its facts.
        const key = decodeStoredReference(row.data_json, account);
        if (key) pendingTracked.add(key);
      }
    }
    const saveDetail = (ref: SourceControlPullRequestRef, detail: ForgeDetail) =>
      Effect.gen(function* () {
        if (detail.number !== ref.number || !detail.title.trim())
          return yield* error(
            "The forge returned an invalid pull request identity.",
            "invalid_response",
          );
        const normalized = forgeTracked(account, ref, detail, provider),
          old = state.get(normalized.key)?.pr;
        const pr = {
          ...normalized,
          ...(old
            ? {
                snoozedUntil: old.snoozedUntil,
                ignoredAt: old.ignoredAt,
                ...(old.acknowledgedAt ? { acknowledgedAt: old.acknowledgedAt } : {}),
              }
            : {}),
          ...(old && old.headRefOid === normalized.headRefOid
            ? { additions: old.additions, deletions: old.deletions, changedFiles: old.changedFiles }
            : {}),
        };
        if (old && old.headRefOid !== normalized.headRefOid) {
          filesCache.delete(pr.key);
          threadsCache.delete(pr.key);
        }
        if (!old && !pendingTracked.has(pr.key) && state.size + pendingTracked.size >= MAX_TRACKED)
          return yield* error("This account reached the 500 tracked request limit.", "forbidden");
        const stored = yield* Effect.try({
          try: () => ({
            generation: account.generation,
            pr: Schema.decodeUnknownSync(TrackedPullRequest)(pr),
            detail: Schema.decodeUnknownSync(PrHubDetailResult)(forgeDetail(pr, detail)),
            ...(forgeComparison(ref, detail) ? { comparison: forgeComparison(ref, detail)! } : {}),
          }),
          catch: () =>
            error("The forge returned invalid pull request metadata.", "invalid_response"),
        });
        // Publish only after persistence so a failed disk write leaves the old fact intact.
        yield* persist(stored);
        state.set(pr.key, stored);
        pendingTracked.delete(pr.key);
        return pr;
      });
    const refreshOne = (ref: SourceControlPullRequestRef) =>
      Effect.gen(function* () {
        const detail = yield* provider.getDetail(ref);
        return yield* saveDetail(ref, detail);
      });
    const refreshNow: PrHubServiceShape["refreshNow"] = (input) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          const previous = snapshot();
          const interval =
            (yield* settings.getSettings.pipe(Effect.catch(() => Effect.succeed(null))))?.prHub
              .pollIntervalSeconds ?? 180;
          if (
            input.mode !== "force" &&
            lastAttempt &&
            Date.now() - lastAttempt < Math.max(interval, 30) * 1000
          )
            return snapshot();
          lastAttempt = Date.now();
          let failures = 0;
          const identity = yield* assertGeneration(input.accountGeneration).pipe(Effect.result);
          if (identity._tag === "Failure") {
            status = "auth_required";
            warning = "Account credentials changed. Select the account again.";
            yield* publish(previous);
            return snapshot();
          }
          const discoveredKeys = new Set<string>();
          const routing = Option.isSome(accounts)
            ? yield* accounts.value.listRouting().pipe(Effect.catch(() => Effect.succeed([])))
            : [];
          for (const route of routing
            .filter(
              (value) =>
                value.accountId === account.id &&
                value.provider === account.provider &&
                value.host === account.host,
            )
            .slice(0, 50)) {
            const ref = {
              provider: account.provider,
              host: account.host,
              repository: route.repository,
              number: 1,
            };
            const discovered = yield* provider.listPullRequests(ref, 100).pipe(Effect.result);
            if (discovered._tag === "Failure") {
              failures++;
              continue;
            }
            for (const detail of discovered.success.slice(0, 100)) {
              if (!Number.isInteger(detail.number) || detail.number < 1) continue;
              const saved = yield* saveDetail({ ...ref, number: detail.number }, detail).pipe(
                Effect.result,
              );
              if (saved._tag === "Failure") failures++;
              else discoveredKeys.add(saved.success.key);
            }
          }
          for (const key of new Set([...state.keys(), ...pendingTracked])) {
            if (discoveredKeys.has(key)) continue;
            const ref = yield* refFor(key).pipe(Effect.result);
            if (ref._tag === "Failure") {
              state.delete(key);
              pendingTracked.delete(key);
              failures++;
              continue;
            }
            const updated = yield* refreshOne(ref.success).pipe(Effect.result);
            if (updated._tag === "Failure") failures++;
          }
          lastPolledAt = new Date().toISOString();
          status = failures ? "degraded" : "ok";
          warning = failures
            ? "Some forge reads failed. Last verified requests remain visible."
            : undefined;
          yield* publish(previous);
          return snapshot();
        }),
      );
    const track: PrHubServiceShape["track"] = (input) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          yield* assertGeneration(input.accountGeneration);
          const ref = parseSourceControlPullRequestUrl(input.url, account.provider, account.host);
          if (!ref)
            return yield* error("Invalid pull request URL for this forge account.", "forbidden");
          yield* refFor(
            `${ref.provider}:${ref.host}/${ref.repository}#${ref.number}`,
            input.accountGeneration,
          );
          const previous = snapshot(),
            pr = yield* refreshOne(ref);
          yield* publish(previous);
          return pr;
        }),
      );
    const getDetail: PrHubServiceShape["getDetail"] = (input) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          const ref = yield* refFor(input.key, input.accountGeneration),
            cached = state.get(input.key);

          if (
            input.mode !== "force" &&
            cached &&
            Date.now() - (detailAttempts.get(input.key) ?? 0) < CACHE_MS
          )
            return { ...cached.detail, stale: detailErrors.has(input.key) };
          if (
            input.mode !== "force" &&
            Date.now() - (detailAttempts.get(input.key) ?? 0) < CACHE_MS &&
            detailErrors.has(input.key)
          )
            return yield* detailErrors.get(input.key)!;
          remember(detailAttempts, input.key, Date.now(), MAX_TRACKED);
          const previous = snapshot(),
            read = yield* refreshOne(ref).pipe(Effect.result);
          if (read._tag === "Failure") {
            remember(detailErrors, input.key, read.failure, MAX_TRACKED);
            if (cached)
              return {
                ...cached.detail,
                stale: true,
                warning: "Forge refresh failed; showing the last verified detail.",
              };
            return yield* read.failure;
          }
          detailErrors.delete(input.key);
          yield* publish(previous);
          return state.get(input.key)!.detail;
        }),
      );
    const getFiles: PrHubServiceShape["getFiles"] = (input) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          const ref = yield* refFor(input.key, input.accountGeneration),
            cached = filesCache.get(input.key);
          if (input.comparisonMode === "changes_since_review")
            return yield* error("This forge does not expose a reviewed comparison baseline.");
          if (input.cursor)
            return yield* error("This native file connection cannot accept a guessed cursor.");
          if (
            input.mode !== "force" &&
            cached &&
            Date.now() - cached.attemptedAt < CACHE_MS &&
            cached.value
          )
            return { ...cached.value, stale: cached.failed };
          if (input.mode !== "force" && cached?.error && Date.now() - cached.attemptedAt < CACHE_MS)
            return yield* cached.error;
          const now = Date.now(),
            read = yield* Effect.gen(function* () {
              const before = yield* provider.getDetail(ref),
                comparison = forgeComparison(ref, before);
              const files = yield* provider.getFiles(ref);
              if (comparison) {
                const after = forgeComparison(ref, yield* provider.getDetail(ref));
                if (!after || JSON.stringify(after) !== JSON.stringify(comparison))
                  return yield* error(
                    "Diff revisions changed while loading files. Refresh before continuing.",
                    "forbidden",
                  );
              }
              return { files, comparison, detail: before };
            }).pipe(Effect.result);
          if (read._tag === "Failure") {
            remember(filesCache, input.key, {
              ...cached,
              attemptedAt: now,
              failed: true,
              error: read.failure,
            });
            if (cached?.value)
              return {
                ...cached.value,
                stale: true,
                warning: "Forge refresh failed; showing the last verified files.",
              };
            return yield* read.failure;
          }
          const files = read.success.files.map((file) => ({
            path: file.path,
            previousPath: file.previousPath,
            blobOid: file.revision,
            patch: file.patch,
            patchStatus: file.patch ? ("available" as const) : ("unavailable" as const),
            additions:
              file.patch
                ?.split("\n")
                .filter((line) => line.startsWith("+") && !line.startsWith("+++")).length ?? 0,
            deletions:
              file.patch
                ?.split("\n")
                .filter((line) => line.startsWith("-") && !line.startsWith("---")).length ?? 0,
            changeType:
              file.status === "added"
                ? ("added" as const)
                : file.status === "removed" || file.status === "deleted"
                  ? ("deleted" as const)
                  : file.status === "renamed"
                    ? ("renamed" as const)
                    : ("changed" as const),
          }));
          const previous = snapshot();
          yield* saveDetail(ref, read.success.detail);
          const value: PrHubFilesPage = {
            files,
            ...(read.success.comparison ? { comparison: read.success.comparison } : {}),
            pageInfo: { ...PAGE_INFO, truncated: files.length >= 100 },
            stale: false,
            refreshedAt: new Date().toISOString(),
          };
          if (filesCache.size >= 100 && !cached) filesCache.delete(filesCache.keys().next().value!);
          remember(filesCache, input.key, { value, attemptedAt: now, failed: false });
          const stored = state.get(input.key);
          if (stored) {
            const pr = {
              ...stored.pr,
              changedFiles: files.length,
              additions: files.reduce((sum, file) => sum + file.additions, 0),
              deletions: files.reduce((sum, file) => sum + file.deletions, 0),
            };
            const updated = {
              ...stored,
              pr,
              detail: {
                ...stored.detail,
                detail: {
                  ...stored.detail.detail,
                  changedFiles: pr.changedFiles,
                  additions: pr.additions,
                  deletions: pr.deletions,
                },
              },
            };
            yield* persist(updated);
            state.set(input.key, updated);
          }
          yield* publish(previous);
          return value;
        }),
      );
    const getTimeline: PrHubServiceShape["getTimeline"] = (input) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          const ref = yield* refFor(input.key, input.accountGeneration),
            cached = timelineCache.get(input.key);
          if (input.cursor)
            return yield* error("This native timeline cannot accept a guessed cursor.");
          if (
            input.mode !== "force" &&
            cached &&
            Date.now() - cached.attemptedAt < CACHE_MS &&
            cached.value
          )
            return { ...cached.value, stale: cached.failed };
          if (input.mode !== "force" && cached?.error && Date.now() - cached.attemptedAt < CACHE_MS)
            return yield* cached.error;
          const now = Date.now(),
            read = yield* provider.getComments(ref).pipe(Effect.result);
          if (read._tag === "Failure") {
            remember(timelineCache, input.key, {
              ...cached,
              attemptedAt: now,
              failed: true,
              error: read.failure,
            });
            if (cached?.value)
              return {
                ...cached.value,
                stale: true,
                warning: "Forge refresh failed; showing the last verified timeline.",
              };
            return yield* read.failure;
          }
          const comments = read.success.flatMap((value) =>
            Array.isArray(value.notes)
              ? value.notes.map(record)
              : Array.isArray(value.comments)
                ? value.comments.map(record)
                : [value],
          );
          const entries: PrHubTimelinePage["entries"] = comments
            .filter((comment) => comment.system !== true)
            .map((comment) => ({
              type: "comment",
              id: String(comment.id ?? ""),
              databaseId: null,
              kind:
                record(comment.position).new_path ||
                record(comment.position).old_path ||
                record(comment.inline).path ||
                comment.path
                  ? "review-comment"
                  : "issue-comment",
              author: login(comment.author ?? comment.user)
                ? { login: login(comment.author ?? comment.user)!, name: null, avatarUrl: null }
                : null,
              body:
                text(comment.body) ??
                text(record(comment.content).raw) ??
                text(comment.content) ??
                "",
              createdAt:
                validDate(comment.created_at ?? comment.created_on ?? comment.publishedDate) ??
                new Date().toISOString(),
              updatedAt: validDate(comment.updated_at ?? comment.updated_on),
              url: text(comment.html_url) ?? text(record(record(comment.links).html).href),
              path: null,
              line: null,
              reviewState: null,
              viewerCanUpdate:
                provider.forgeCapabilities.edit.comment &&
                forgeUserMatches(comment.author ?? comment.user, account) &&
                !(account.provider === "forgejo" && nativeCommentIsInline(comment)) &&
                (typeof comment.id === "number" || typeof comment.id === "string"),
              reactions: [],
            }));
          const value: PrHubTimelinePage = {
            entries,
            pageInfo: { ...PAGE_INFO, truncated: read.success.length >= 100 },
            stale: false,
            refreshedAt: new Date().toISOString(),
          };
          if (timelineCache.size >= 100 && !cached)
            timelineCache.delete(timelineCache.keys().next().value!);
          remember(timelineCache, input.key, { value, attemptedAt: now, failed: false });
          return value;
        }),
      );
    const readThreads = (input: { key: string; accountGeneration?: string | undefined }) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          const ref = yield* refFor(input.key, input.accountGeneration),
            cached = threadsCache.get(input.key);
          if (cached && Date.now() - cached.attemptedAt < CACHE_MS) {
            if (cached.value) return { threads: cached.value, stale: cached.failed };
            if (cached.error) return yield* cached.error;
          }
          const now = Date.now(),
            read = yield* provider.getReviewThreads(ref).pipe(Effect.result);
          if (read._tag === "Failure") {
            remember(threadsCache, input.key, {
              ...cached,
              attemptedAt: now,
              failed: true,
              error: read.failure,
            });
            if (cached?.value) return { threads: cached.value, stale: true };
            return yield* read.failure;
          }
          const threads = forgeReviewThreads(read.success, provider);
          if (threadsCache.size >= 100 && !cached)
            threadsCache.delete(threadsCache.keys().next().value!);
          remember(threadsCache, input.key, { value: threads, attemptedAt: now, failed: false });
          return { threads, stale: false };
        }),
      );
    const editLocal = (
      key: string,
      generation: string | undefined,
      patch: Partial<TrackedPullRequest>,
    ) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          yield* refFor(key, generation);
          const stored = state.get(key);
          if (!stored) return yield* error("Pull request is not tracked.", "not_found");
          const previous = snapshot(),
            updated = { ...stored, pr: { ...stored.pr, ...patch } };
          yield* persist(updated);
          state.set(key, updated);
          yield* publish(previous);
          return snapshot();
        }),
      );
    const startMonitoring = Effect.suspend(() => {
      if (monitoring) return Effect.void;
      monitoring = true;
      return Effect.forever(
        Effect.gen(function* () {
          const interval =
            (yield* settings.getSettings.pipe(Effect.catch(() => Effect.succeed(null))))?.prHub
              .pollIntervalSeconds ?? 180;
          if (interval !== 0) yield* refreshNow({ mode: "if_stale" });
          yield* Effect.sleep(`${interval === 0 ? 30 : Math.max(interval, 30)} seconds`);
        }),
      ).pipe(Effect.forkIn(scope), Effect.asVoid);
    });
    const resolveCheckout: PrHubServiceShape["resolveLocalCheckout"] = (input) =>
      Effect.gen(function* () {
        yield* refFor(input.key, input.accountGeneration);
        const stored = state.get(input.key);
        if (!stored) return yield* error("Pull request is not tracked.", "not_found");
        const allProjects = Option.isSome(projects)
          ? yield* projects.value.listAll().pipe(Effect.catch(() => Effect.succeed([])))
          : [];
        return yield* Effect.tryPromise({
          try: (signal) =>
            resolveLocalCheckout({
              repository: stored.pr.repository,
              host: account.host,
              provider: account.provider,
              projects: allProjects.filter((project) => project.deletedAt === null),
              ...(input.baseDirectory ? { baseDirectory: input.baseDirectory } : {}),
              ...(input.selectedPath ? { selectedPath: input.selectedPath } : {}),
              signal,
            }),
          catch: () => error("Could not inspect local repositories.", "generic"),
        });
      });
    return {
      startMonitoring,
      getSnapshot: Effect.sync(snapshot),
      refreshNow,
      streamChanges: Stream.fromPubSub(changes),
      getOverview: (input) =>
        Effect.sync(() => prHubOverview(snapshot(), String(revision), input.stalledBefore)),
      listPullRequests: (input) =>
        Effect.sync(() => listPrHubPullRequests(snapshot(), String(revision), input)),
      track,
      getDetail,
      getFiles,
      getTimeline,
      getReviewThreads: (input) =>
        readThreads(input).pipe(
          Effect.map((result) => ({
            threads: result.threads,
            pageInfo: { ...PAGE_INFO, truncated: result.stale },
            comparisonVersion: state.get(input.key)?.pr.headRefOid ?? "unknown",
            refreshedAt: new Date().toISOString(),
          })),
        ),
      getUnresolvedThreads: (input) =>
        readThreads(input).pipe(
          Effect.map((result) => ({
            threads: result.threads.filter((thread) => !thread.isResolved),
            truncated: result.stale,
            omittedCount: 0,
            stale: result.stale,
            refreshedAt: new Date().toISOString(),
            ...(!provider.forgeCapabilities.review.resolve
              ? { warning: "This forge does not report review-thread resolution." }
              : {}),
          })),
        ),
      resolveLocalCheckout: resolveCheckout,
      listLocalCheckoutCandidates: (input) =>
        resolveCheckout(input).pipe(
          Effect.map((rows) =>
            rows
              .filter((row) => row.projectId !== null)
              .map((row) => ({ ...row, projectId: row.projectId! })),
          ),
          Effect.catch(() => Effect.succeed([])),
        ),
      snooze: (input) =>
        editLocal(input.key, input.accountGeneration, { snoozedUntil: input.until }),
      unsnooze: (input) => editLocal(input.key, input.accountGeneration, { snoozedUntil: null }),
      ignore: (input) =>
        editLocal(input.key, input.accountGeneration, {
          ignoredAt: new Date().toISOString(),
        }),
      acknowledgeAttention: (input) =>
        editLocal(input.key, input.accountGeneration, {
          acknowledgedAt: new Date().toISOString(),
          notificationPending: false,
        }),
      markSeen: (input) => editLocal(input.key, input.accountGeneration, {}),
      markNotified: (input) =>
        editLocal(input.key, input.accountGeneration, { notificationPending: false }),
      approve: unsupported,
      requestChanges: unsupported,
      comment: unsupported,
      merge: unsupported,
      markReady: unsupported,
      reRequestReview: unsupported,
      claimNotifications: unsupported,
      acknowledgeNotifications: unsupported,
      replyReviewThread: unsupported,
      recoverReply: unsupported,
      getReplyDraft: unsupported,
      saveReplyDraft: unsupported,
      getReplyOperation: unsupported,
      setReviewThreadState: unsupported,
      getReviewDraft: unsupported,
      prepareComment: unsupported,
      submitComment: unsupported,
      getCommentOperation: unsupported,
      recoverComment: unsupported,
      prepareQuickReview: unsupported,
      prepareReview: unsupported,
      recoverReview: unsupported,
      submitReview: unsupported,
      getReviewOperation: unsupported,
      cancelReviewPreparation: unsupported,
      saveReviewDraft: unsupported,
      updateComment: unsupported,
      setReaction: unsupported,
      changeReviewers: unsupported,
      updateBranch: unsupported,
      clearData: unsupported,
    } satisfies PrHubServiceShape;
  });
const validDate = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;

function decodeStored(json: string, account: ForgeAccount): Stored | null {
  try {
    const value = record(JSON.parse(json));
    if (value.generation !== account.generation) return null;
    const pr = Schema.decodeUnknownSync(TrackedPullRequest)(value.pr);
    const detail = Schema.decodeUnknownSync(PrHubDetailResult)(value.detail);
    const ref = parseSourceControlPullRequestKey(pr.key);
    return ref?.provider === account.provider &&
      ref.host.toLowerCase() === account.host.toLowerCase()
      ? {
          generation: account.generation,
          pr,
          detail,
          ...(value.comparison
            ? { comparison: Schema.decodeUnknownSync(PrHubComparisonIdentity)(value.comparison) }
            : {}),
        }
      : null;
  } catch {
    return null;
  }
}

function remember<A>(cache: Map<string, A>, key: string, value: A, limit = 100): void {
  if (cache.size >= limit && !cache.has(key)) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
}

function decodeStoredReference(json: string, account: ForgeAccount): string | null {
  try {
    const value = record(JSON.parse(json));
    const key = text(record(value.pr).key);
    const ref = key ? parseSourceControlPullRequestKey(key) : null;
    return ref?.provider === account.provider &&
      ref.host.toLowerCase() === account.host.toLowerCase()
      ? key
      : null;
  } catch {
    return null;
  }
}

function nativeCommentIsInline(comment: Readonly<Record<string, unknown>>): boolean {
  return !!(
    record(comment.position).new_path ||
    record(comment.position).old_path ||
    record(comment.inline).path ||
    comment.path
  );
}
