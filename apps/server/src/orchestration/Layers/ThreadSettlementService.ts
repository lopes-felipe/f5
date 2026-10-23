import { GitHubRequestPolicy } from "../../git/githubRequestPolicy.ts";
import { GitHubCliError } from "../../git/Errors.ts";
import { GitManager } from "../../git/Services/GitManager.ts";
import { isPrHubRepositoryExcluded } from "../../prHub/repositoryPolicy.ts";
import { forgeTerminalDates } from "../../prHub/forgeModel.ts";
import { makeThreadSettlementHooks } from "../threadSettlementHooks.ts";
import {
  CommandId,
  ProjectId,
  PullRequestKey,
  ThreadId,
  type OrchestrationThread,
  type ThreadSettledBy,
} from "@t3tools/contracts";
import { formatSourceControlPullRequestKey } from "@t3tools/shared/sourceControl";
import {
  Cause,
  Clock,
  Data,
  Effect,
  Exit,
  Layer,
  Option,
  Queue,
  Schedule,
  Scope,
  Semaphore,
  ServiceMap,
  Stream,
} from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerSettingsService } from "../../serverSettings.ts";
import { readProjectSettings } from "../../project/projectSettings.ts";
import { PrHubFederation } from "../../prHub/Layers/PrHubFederation.ts";
import { PrHubExtensions } from "../../prHub/PrHubExtensions.ts";
import { GitHubRequestPriority, GitHubSyncWait } from "../../git/githubRequestScheduler.ts";
import { NextTurnQueueDispatcher } from "../../nextTurnQueue/Services/NextTurnQueueDispatcher.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  isAutoSettlementCandidate,
  isIdleSettlementCandidate,
  resolveAutoSettlementAt,
  type SettlementCandidate,
  type SettlementPullRequest,
} from "../threadSettlement.ts";

export class ThreadSettlementError extends Data.TaggedError("ThreadSettlementError")<{
  readonly message: string;
}> {}
const failure = () =>
  new ThreadSettlementError({
    message:
      "Settlement could not complete. Check pending work and the current thread, then retry.",
  });
export class ThreadSettlementService extends ServiceMap.Service<
  ThreadSettlementService,
  Effect.Success<typeof makeThreadSettlementService>
>()("t3/orchestration/Layers/ThreadSettlementService") {}
export const makeThreadSettlementService = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* OrchestrationEngineService;
  const settingsService = yield* ServerSettingsService;
  const federation = yield* Effect.serviceOption(PrHubFederation);
  const links = yield* Effect.serviceOption(PrHubExtensions);
  const gitManager = yield* Effect.serviceOption(GitManager);
  const terminal = yield* Effect.serviceOption(TerminalManager);
  const dispatcher = yield* NextTurnQueueDispatcher;
  const hooks = yield* makeThreadSettlementHooks;
  const gate = yield* Semaphore.make(1);
  const requests = yield* Queue.dropping<void>(1);
  yield* Effect.addFinalizer(() => Queue.shutdown(requests));
  const requestSweep = Queue.offer(requests, undefined).pipe(Effect.asVoid);
  const threadById = (threadId: ThreadId) =>
    engine.getReadModel().pipe(
      Effect.flatMap((model) => {
        const thread = model.threads.find((thread) => thread.id === threadId && !thread.deletedAt);
        return thread ? Effect.succeed(thread) : Effect.fail(failure());
      }),
    );
  const readCandidate = (thread: OrchestrationThread) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        queued: number;
        request: number;
        background: number;
        watch: number;
        latestUser: string | null;
        lastUnsettledAt: string | null;
        linkedCount: number;
      }>`SELECT
      (EXISTS(SELECT 1 FROM next_turn_queue WHERE thread_id=${thread.id} AND deleted_at IS NULL) OR EXISTS(SELECT 1 FROM next_turn_queue_quarantine WHERE thread_id=${thread.id}) OR EXISTS(SELECT 1 FROM next_turn_queue_state WHERE thread_id=${thread.id} AND worktree_block_token IS NOT NULL)) AS queued,
      (EXISTS(SELECT 1 FROM projection_pending_approvals WHERE thread_id=${thread.id} AND status='pending') OR EXISTS(SELECT 1 FROM projection_pending_user_inputs WHERE thread_id=${thread.id} AND resolution IS NULL)) AS request,
      EXISTS(SELECT 1 FROM projection_thread_background_work WHERE thread_id=${thread.id} AND active=1) AS background,
      EXISTS(SELECT 1 FROM thread_pull_request_watches WHERE thread_id=${thread.id}) AS watch,
      (SELECT last_unsettled_at FROM projection_threads WHERE thread_id=${thread.id}) AS "lastUnsettledAt",
      (SELECT count(*) FROM projection_thread_pull_requests WHERE thread_id=${thread.id}) AS linkedCount,
      (SELECT MAX(m.created_at) FROM projection_thread_messages m LEFT JOIN thread_message_authorship a ON a.message_id=m.message_id AND a.thread_id=m.thread_id WHERE m.thread_id=${thread.id} AND m.role='user' AND coalesce(a.source,'human')='human') AS latestUser`;
      const row = rows[0]!;
      return {
        thread,
        hasQueuedWork: !!row.queued,
        hasPendingRequest: !!row.request,
        hasBackgroundWork: !!row.background,
        hasWatch: !!row.watch,
        latestUserAuthoredMessageAt: row.latestUser,
        lastUnsettledAt: row.lastUnsettledAt,
        linkedCount: row.linkedCount,
      } satisfies SettlementCandidate & {
        latestUserAuthoredMessageAt: string | null;
        lastUnsettledAt: string | null;
        linkedCount: number;
      };
    });
  const settle = (thread: OrchestrationThread, settledBy: ThreadSettledBy, settledAt?: string) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        engine.dispatch({
          type: "thread.settle",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          threadId: thread.id,
          createdAt: new Date(now).toISOString(),
          settledBy,
          expectedUpdatedAt: thread.updatedAt,
          ...(settledAt ? { settledAt } : {}),
        }),
      ),
      Effect.asVoid,
    );
  const settleProjectIdle = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const model = yield* engine.getReadModel();
      let settled = 0;
      for (const thread of model.threads.filter(
        (thread) => thread.projectId === projectId && !thread.deletedAt,
      )) {
        const candidate = yield* readCandidate(thread);
        if (!isIdleSettlementCandidate(candidate, now) || candidate.hasWatch) continue;
        if ((yield* settle(thread, "user").pipe(Effect.result))._tag === "Success") settled++;
      }
      return { settled };
    }).pipe(Effect.mapError(failure));
  const settleFromAgent = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const generation =
        (yield* sql<{
          generation: number;
        }>`SELECT generation FROM thread_pull_request_watch_stops WHERE thread_id=${threadId}`)[0]
          ?.generation ?? 0;
      const thread = yield* threadById(threadId);
      if (thread.settledAt) return { settled: true, deferred: false };
      if (thread.archivedAt || thread.pinnedAt) return yield* failure();
      const activeTurn =
        thread.session?.activeTurnId ??
        (thread.latestTurn?.state === "running" ||
        (thread.latestTurn?.completedAt && thread.latestTurn.processingQuiescedAt === null)
          ? thread.latestTurn!.turnId
          : null);
      if (!activeTurn) {
        yield* settle(thread, "agent");
        return { settled: true, deferred: false };
      }
      const now = new Date(yield* Clock.currentTimeMillis).toISOString();
      const inserted =
        yield* sql`INSERT INTO thread_settlement_requests(thread_id,turn_id,requested_at) SELECT thread_id,${activeTurn},${now} FROM projection_threads WHERE thread_id=${threadId} AND deleted_at IS NULL AND archived_at IS NULL AND updated_at=${thread.updatedAt} AND coalesce((SELECT generation FROM thread_pull_request_watch_stops WHERE thread_id=${threadId}),0)=${generation} ON CONFLICT(thread_id) DO UPDATE SET turn_id=excluded.turn_id,requested_at=excluded.requested_at RETURNING thread_id`;
      if (!inserted.length) return yield* failure();
      // A send/Stop may have raced the insert; re-read before acknowledging a deferred intent.
      const current = yield* threadById(threadId);
      if (
        (current.session?.activeTurnId ?? current.latestTurn?.turnId) !== activeTurn ||
        current.deletedAt ||
        current.archivedAt
      ) {
        yield* sql`DELETE FROM thread_settlement_requests WHERE thread_id=${threadId} AND turn_id=${activeTurn} AND requested_at=${now}`;
        return yield* failure();
      }
      return { settled: false, deferred: true };
    }).pipe(Effect.mapError(failure));
  const closeIdleTerminals = (threadId: ThreadId, settledAt: string) => {
    if (Option.isNone(terminal) || !terminal.value.closeIdleForThread) return Effect.void;
    const manager = terminal.value;
    const close = manager.closeIdleForThread;
    return Effect.scoped(
      Effect.gen(function* () {
        const sessions = yield* manager.listSessions;
        if (!sessions.some((session) => session.threadId === threadId)) return;
        const lock = yield* engine.acquireMaintenanceLock();
        yield* Effect.addFinalizer(() => Scope.close(lock, Exit.void));
        if ((yield* threadById(threadId)).settledAt === settledAt) yield* close!(threadId);
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Idle terminals could not be closed after settlement"),
      ),
    );
  };
  const wakeQueued = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const thread = yield* threadById(threadId);
      if (!thread.settledAt) return;
      if (!(yield* readCandidate(thread)).hasQueuedWork) return;
      yield* engine.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.makeUnsafe(crypto.randomUUID()),
        threadId,
        reason: "wake",
        createdAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
      });
    });
  let sweepOffset = 0;
  const sweep = gate
    .withPermits(1)(
      Effect.gen(function* () {
        const global = yield* settingsService.getSettings;
        const model = yield* engine.getReadModel();
        const now = yield* Clock.currentTimeMillis;
        const requests = yield* sql<{
          threadId: string;
          turnId: string;
          requestedAt: string;
        }>`SELECT thread_id AS "threadId",turn_id AS "turnId",requested_at AS "requestedAt" FROM thread_settlement_requests`;
        const intents = new Map(requests.map((request) => [request.threadId, request]));
        const queuedWakes = yield* sql<{
          threadId: string;
        }>`SELECT DISTINCT t.thread_id AS "threadId" FROM projection_threads t JOIN next_turn_queue q ON q.thread_id=t.thread_id AND q.deleted_at IS NULL WHERE t.settled_at IS NOT NULL AND t.deleted_at IS NULL`;
        for (const wake of queuedWakes)
          yield* wakeQueued(ThreadId.makeUnsafe(wake.threadId)).pipe(Effect.ignore);
        const configured =
          global.autoSettleOnPullRequestMerge ||
          global.autoSettleAfterDays !== null ||
          Object.values(global.projectSettingsOverrides).some(
            (settings) =>
              settings.autoSettleOnPullRequestMerge || settings.autoSettleAfterDays != null,
          );
        if (!configured && !intents.size) return;
        const projectSettings = new Map<ProjectId, import("@t3tools/contracts").ServerSettings>();
        const prReads = new Map<string, Effect.Effect<SettlementPullRequest | null>>();
        const branchReads = new Map<
          string,
          Effect.Effect<
            | import("../../sourceControl/SourceControlProvider.ts").SourceControlPullRequestSummary
            | null
            | undefined
          >
        >();
        const prCacheGate = yield* Semaphore.make(1);
        const readBranch = (cwd: string, branch: string) =>
          Effect.gen(function* () {
            const key = JSON.stringify([cwd, branch]);
            const cached = yield* prCacheGate.withPermits(1)(
              Effect.gen(function* () {
                const existing = branchReads.get(key);
                if (existing) return existing;
                if (prReads.size + branchReads.size >= 32 || Option.isNone(gitManager))
                  return Effect.succeed(undefined);
                const read = yield* Effect.cached(
                  gitManager.value.branchPullRequest({ cwd, branch }).pipe(
                    Effect.timeout("15 seconds"),
                    Effect.catchCause((cause) =>
                      Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed(undefined),
                    ),
                  ),
                );
                branchReads.set(key, read);
                return read;
              }),
            );
            return yield* cached;
          });
        const readPullRequest = (
          key: PullRequestKey,
          url: string,
          direct = false,
          expectedHeadOid?: string | null,
        ) =>
          Effect.gen(function* () {
            // Inbox freshness and exact branch-head proof have different admission rules.
            const cacheKey = JSON.stringify([key, direct, expectedHeadOid ?? null]);
            const cached = yield* prCacheGate.withPermits(1)(
              Effect.gen(function* () {
                const existing = prReads.get(cacheKey);
                if (existing) return existing;
                // Rotate the starting thread each sweep so the bounded remote budget remains fair.
                if (prReads.size + branchReads.size >= 32 || Option.isNone(federation))
                  return Effect.succeed(null);
                const router = federation.value;
                const read = yield* Effect.cached(
                  router.resolve({ key }).pipe(
                    Effect.flatMap((runtime) =>
                      Effect.gen(function* () {
                        if (direct) {
                          const ref = yield* router.parseUrl(url);
                          if (!ref || formatSourceControlPullRequestKey(ref) !== key) return null;
                          const policyFailure = () =>
                            new GitHubCliError({
                              operation: "settlement.read",
                              kind: "forbidden",
                              detail: "PR monitoring policy could not be verified.",
                            });
                          const allowed = settingsService.getSettings.pipe(
                            Effect.mapError(policyFailure),
                            Effect.flatMap((current) =>
                              isPrHubRepositoryExcluded(current, ref.repository)
                                ? Effect.fail(policyFailure())
                                : Effect.void,
                            ),
                          );
                          yield* allowed;
                          const parent = yield* Effect.serviceOption(GitHubRequestPolicy);
                          const detail = yield* runtime.provider.getDetail(ref).pipe(
                            Effect.provideService(GitHubRequestPolicy, {
                              beforeSend: (write) =>
                                (Option.isSome(parent)
                                  ? parent.value.beforeSend(write)
                                  : Effect.void
                                ).pipe(Effect.andThen(allowed)),
                              readInvalidated: Option.isSome(parent)
                                ? parent.value.readInvalidated
                                : Effect.never,
                            }),
                          );
                          yield* router.resolve({
                            key,
                            accountId: runtime.account.id,
                            accountGeneration: runtime.account.generation,
                          });
                          yield* allowed;
                          if (
                            !detail.state ||
                            !expectedHeadOid ||
                            detail.headRefOid !== expectedHeadOid
                          )
                            return null;
                          return {
                            state: detail.state,
                            ...forgeTerminalDates(detail.raw, detail.state),
                          } satisfies SettlementPullRequest;
                        }
                        const snapshot = yield* runtime.hub.getSnapshot;
                        if (
                          ![...snapshot.pullRequests, ...snapshot.recentlyResolved].some(
                            (pr) => pr.key === key,
                          )
                        )
                          yield* runtime.hub.track({
                            url,
                            accountGeneration: runtime.account.generation,
                          });
                        const detail = yield* runtime.hub.getDetail({
                          key,
                          accountGeneration: runtime.account.generation,
                          mode: "if_stale",
                        });
                        yield* router.resolve({
                          key,
                          accountId: runtime.account.id,
                          accountGeneration: runtime.account.generation,
                        });
                        return detail.stale
                          ? null
                          : ({
                              state: detail.detail.state,
                              mergedAt: detail.detail.mergedAt,
                              closedAt: detail.detail.closedAt,
                            } satisfies SettlementPullRequest);
                      }),
                    ),
                    Effect.timeout("15 seconds"),
                    Effect.catchCause((cause) =>
                      Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed(null),
                    ),
                  ),
                );
                prReads.set(cacheKey, read);
                return read;
              }),
            );
            return yield* cached;
          });
        const offset = model.threads.length ? sweepOffset % model.threads.length : 0;
        const ordered = [...model.threads.slice(offset), ...model.threads.slice(0, offset)];
        sweepOffset = offset + 32;
        const lookupCandidates = yield* Effect.forEach(
          ordered,
          (initial) =>
            Effect.gen(function* () {
              const intent = intents.get(initial.id);
              if (
                intent &&
                (initial.deletedAt ||
                  initial.archivedAt ||
                  initial.latestTurn?.turnId !== intent.turnId ||
                  initial.latestTurn?.state === "interrupted")
              ) {
                yield* sql`DELETE FROM thread_settlement_requests WHERE thread_id=${initial.id} AND turn_id=${intent.turnId}`;
                return;
              }
              if (!isIdleSettlementCandidate({ thread: initial }, now)) return;
              const candidate = yield* readCandidate(initial);
              if (intent && isIdleSettlementCandidate(candidate, now)) {
                yield* settle(initial, "agent").pipe(Effect.ignore);
                return;
              }
              if (!configured || !isAutoSettlementCandidate(candidate, now)) return;
              const project = model.projects.find(
                (project) => project.id === initial.projectId && !project.deletedAt,
              );
              if (!project) return;
              let settings = projectSettings.get(project.id);
              if (!settings) {
                settings = (yield* readProjectSettings(global, project)).settings;
                projectSettings.set(project.id, settings);
              }
              if (!settings.autoSettleOnPullRequestMerge && settings.autoSettleAfterDays === null)
                return;
              const inactiveAt = resolveAutoSettlementAt({
                ...candidate,
                nowMs: now,
                pullRequests: candidate.linkedCount ? [null] : [],
                autoSettleOnPullRequestMerge: false,
                autoSettleAfterDays: settings.autoSettleAfterDays,
                autoSettleKeepPullRequests: settings.autoSettleKeepPullRequests,
              });
              if (inactiveAt) {
                yield* settle(initial, "auto", inactiveAt).pipe(Effect.ignore);
                return;
              }
              if (
                !settings.autoSettleOnPullRequestMerge ||
                (!candidate.linkedCount && !initial.branch)
              )
                return;
              return { initial, candidate, settings, project };
            }),
          { concurrency: 8 },
        );
        // Finish local inactivity and agent decisions before any remote host can stall them.
        yield* Effect.forEach(
          lookupCandidates.filter((candidate) => candidate !== undefined),
          ({ initial, candidate, settings, project }) =>
            Effect.gen(function* () {
              const linked =
                candidate.linkedCount > 0 && Option.isSome(links)
                  ? yield* links.value.getThreadLinks(initial.id)
                  : [];
              const prs: Array<SettlementPullRequest | null> =
                candidate.linkedCount > linked.length ? [null] : [];
              for (const ref of linked) {
                const key = formatSourceControlPullRequestKey(ref);
                if (!settings.autoSettleOnPullRequestMerge) {
                  prs.push(null);
                  continue;
                }
                prs.push(yield* readPullRequest(key, ref.url));
              }
              // A branch may have a newer open PR even when an older explicit link is terminal.
              if (
                initial.branch &&
                (!linked.length || (prs.length > 0 && prs.every((pr) => pr && pr.state !== "open")))
              ) {
                const branchPr = yield* readBranch(project.workspaceRoot, initial.branch);
                if (branchPr === undefined) return;
                if (branchPr?.state === "open") prs.push({ state: "open" });
                else if (branchPr) {
                  const ref = Option.isSome(federation)
                    ? yield* federation.value
                        .parseUrl(branchPr.url)
                        .pipe(Effect.orElseSucceed(() => null))
                    : null;
                  prs.push(
                    ref
                      ? yield* readPullRequest(
                          formatSourceControlPullRequestKey(ref),
                          branchPr.url,
                          true,
                          branchPr.headRefOid,
                        )
                      : null,
                  );
                }
              }
              // Re-read local guards and policy after remote waits. Admission still compares updatedAt atomically.
              const latestModel = yield* engine.getReadModel();
              const latestThread = latestModel.threads.find((thread) => thread.id === initial.id);
              const latestProject = latestModel.projects.find(
                (entry) => entry.id === project.id && !entry.deletedAt,
              );
              if (!latestThread || !latestProject || latestThread.updatedAt !== initial.updatedAt)
                return;
              const latestSettings = (yield* readProjectSettings(
                yield* settingsService.getSettings,
                latestProject,
              )).settings;
              const settledAt = resolveAutoSettlementAt({
                ...(yield* readCandidate(latestThread)),
                nowMs: yield* Clock.currentTimeMillis,
                pullRequests: prs,
                autoSettleOnPullRequestMerge: latestSettings.autoSettleOnPullRequestMerge,
                autoSettleAfterDays: latestSettings.autoSettleAfterDays,
                autoSettleKeepPullRequests: latestSettings.autoSettleKeepPullRequests,
              });
              if (settledAt) yield* settle(latestThread, "auto", settledAt).pipe(Effect.ignore);
            }),
          { concurrency: 4, discard: true },
        );
      }),
    )
    .pipe(
      Effect.provideService(GitHubRequestPriority, "cold"),
      Effect.provideService(GitHubSyncWait, false),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Thread settlement sweep could not complete"),
      ),
      Effect.withSpan("ThreadSettlement.sweep"),
    );
  const start = Effect.gen(function* () {
    yield* hooks.start;
    yield* Effect.forever(Queue.take(requests).pipe(Effect.andThen(sweep))).pipe(Effect.forkScoped);
    yield* Stream.runForEach(engine.streamDomainEvents, (event) =>
      event.type === "thread.settled"
        ? closeIdleTerminals(event.payload.threadId, event.payload.settledAt)
        : [
              "thread.meta-updated",
              "thread.session-set",
              "thread.checkpoint-captured",
              "thread.turn-processing-quiesced",
            ].includes(event.type)
          ? requestSweep
          : Effect.void,
    ).pipe(Effect.forkScoped);
    yield* Stream.runForEach(dispatcher.changes, (threadId) =>
      wakeQueued(threadId).pipe(Effect.ignore),
    ).pipe(Effect.forkScoped);
    if (Option.isSome(federation))
      yield* Stream.runForEach(federation.value.hub.streamChanges, () => requestSweep).pipe(
        Effect.forkScoped,
      );
    // Branch status can see a thread's PR merge before the PR hub does.
    const statusChanges = Option.isSome(gitManager) && gitManager.value.pullRequestStateChanges;
    if (statusChanges)
      yield* Stream.runForEach(statusChanges, () => requestSweep).pipe(Effect.forkScoped);
    yield* requestSweep.pipe(Effect.repeat(Schedule.spaced("5 minutes")), Effect.forkScoped);
  });
  return { start, sweep, requestSweep, settleProjectIdle, settleFromAgent, readCandidate };
});
export const ThreadSettlementServiceLive = Layer.effect(
  ThreadSettlementService,
  makeThreadSettlementService,
);
