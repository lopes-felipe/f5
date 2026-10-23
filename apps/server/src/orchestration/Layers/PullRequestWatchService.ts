import {
  CommandId,
  EventId,
  MessageId,
  PullRequestKey,
  ThreadId,
  type OrchestrationThread,
  type PullRequestWatchEntry,
  type PullRequestWatchInput,
} from "@t3tools/contracts";
import {
  formatSourceControlPullRequestKey,
  parseSourceControlPullRequestKey,
} from "@t3tools/shared/sourceControl";
import {
  Cause,
  Clock,
  Effect,
  Exit,
  Layer,
  Option,
  PubSub,
  Schedule,
  Semaphore,
  ServiceMap,
  Stream,
} from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../../config.ts";
import { GitHubRequestPriority, GitHubSyncWait } from "../../git/githubRequestScheduler.ts";
import { NextTurnQueueStore } from "../../nextTurnQueue/Services/NextTurnQueueStore.ts";
import { NextTurnQueueDispatcher } from "../../nextTurnQueue/Services/NextTurnQueueDispatcher.ts";
import { canonicalRequestHash } from "../../nextTurnQueue/canonicalRequestHash.ts";
import { PrHubFederation } from "../../prHub/Layers/PrHubFederation.ts";
import { PrHubExtensions } from "../../prHub/PrHubExtensions.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  makePullRequestWatchStore,
  PullRequestWatchError,
  type PullRequestWatchRow,
} from "../PullRequestWatchStore.ts";
import { evaluatePullRequestWatch, pullRequestWatchMessage } from "../pullRequestWatch.ts";
import {
  readGitHubWatchFingerprint,
  type PullRequestWatchFingerprint,
} from "../pullRequestWatchFingerprint.ts";
import { readPullRequestWatchRemarks } from "../pullRequestWatchRemarks.ts";

interface LastRead {
  readonly at: number;
  readonly status: string | null;
  readonly remarks: string | null;
  readonly snapshot: string;
  readonly watches: ReadonlySet<string>;
  readonly inFlight: boolean;
  readonly remarksComplete: boolean;
}
const active = (thread: OrchestrationThread) =>
  !thread.deletedAt && !thread.archivedAt && !thread.settledAt;
const storageError = () =>
  new PullRequestWatchError({
    message:
      "The PR watch operation could not complete. Retry after checking the thread and forge account.",
  });

export class PullRequestWatchService extends ServiceMap.Service<
  PullRequestWatchService,
  Effect.Success<typeof makePullRequestWatchService>
>()("t3/orchestration/Layers/PullRequestWatchService") {}

export const makePullRequestWatchService = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* OrchestrationEngineService;
  const optionalFederation = yield* Effect.serviceOption(PrHubFederation);
  const federation = () =>
    Option.isSome(optionalFederation)
      ? Effect.succeed(optionalFederation.value)
      : Effect.fail(storageError());
  const optionalLinks = yield* Effect.serviceOption(PrHubExtensions);
  const queue = yield* NextTurnQueueStore;
  const dispatcher = yield* NextTurnQueueDispatcher;
  const config = yield* ServerConfig;
  const store = yield* makePullRequestWatchStore;
  const changes = yield* PubSub.unbounded<ThreadId>();
  yield* Effect.addFinalizer(() => PubSub.shutdown(changes));
  const gate = yield* Semaphore.make(1);
  const lastReads = new Map<string, LastRead>();
  const changed = (threadId: ThreadId) => PubSub.publish(changes, threadId).pipe(Effect.asVoid);
  const readThread = (threadId: ThreadId) =>
    engine.getReadModel().pipe(
      Effect.flatMap((model) => {
        const thread = model.threads.find((thread) => thread.id === threadId && !thread.deletedAt);
        return thread
          ? Effect.succeed(thread)
          : Effect.fail(
              new PullRequestWatchError({ message: "This thread is no longer available." }),
            );
      }),
    );
  const target = (input: PullRequestWatchInput) =>
    Effect.gen(function* () {
      const linked = input.pr
        ? null
        : Option.isSome(optionalLinks)
          ? yield* optionalLinks.value.getThreadLinks(input.threadId)
          : null;
      const ref = input.pr
        ? (parseSourceControlPullRequestKey(input.pr) ??
          (yield* (yield* federation()).parseUrl(input.pr)))
        : linked?.length === 1
          ? linked[0]
          : null;
      if (!ref)
        return yield* new PullRequestWatchError({
          message: "Specify a PR URL or key, or link exactly one PR to this thread.",
        });
      return { ref, key: formatSourceControlPullRequestKey(ref) };
    });
  const list = (threadId: ThreadId) =>
    readThread(threadId).pipe(
      Effect.andThen(store.list(threadId)),
      Effect.map(
        (rows): ReadonlyArray<PullRequestWatchEntry> =>
          rows.map(({ threadId, key, watch }) => ({ threadId, key, watch })),
      ),
    );
  const cancelQueued = (threadId: ThreadId, ids: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      if (!ids.length) return;
      const pending = yield* queue.listByThread(threadId);
      for (const item of pending.items) {
        if (
          item.status === "dispatching" ||
          !ids.some((id) => item.command.commandId.startsWith(`watch:${id}:`))
        )
          continue;
        yield* queue
          .softDelete({ itemId: item.itemId })
          .pipe(
            Effect.catch((error) =>
              error._tag === "NextTurnQueueItemDispatchingError" ||
              error._tag === "NextTurnQueueItemNotFoundError" ||
              error._tag === "NextTurnQueueItemAlreadyRanError"
                ? Effect.void
                : Effect.fail(error),
            ),
          );
      }
      yield* dispatcher.notify(threadId);
    });
  const stopThread = (threadId: ThreadId, key?: PullRequestKey) =>
    Effect.gen(function* () {
      const stopped = yield* sql.withTransaction(
        Effect.gen(function* () {
          const stopped = yield* store.stop(threadId, key);
          yield* cancelQueued(threadId, stopped);
          return stopped;
        }),
      );
      if (stopped.length) yield* changed(threadId);
    });
  const removeWatch = (row: PullRequestWatchRow) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const removed = yield* store.stopExpected(row);
        if (removed) yield* cancelQueued(row.threadId, [row.watchId]);
        return removed;
      }),
    );
  const notice = (row: PullRequestWatchRow, summary: string) =>
    Effect.gen(function* () {
      const at = new Date(yield* Clock.currentTimeMillis).toISOString();
      yield* engine
        .dispatch({
          type: "thread.activity.append",
          threadId: row.threadId,
          commandId: CommandId.makeUnsafe(`watch-notice:${row.watchId}:${row.version}`),
          createdAt: at,
          activity: {
            id: EventId.makeUnsafe(`watch-notice:${row.watchId}:${row.version}`),
            tone: "info",
            kind: "prWatch.stopped",
            summary,
            payload: { key: row.key },
            turnId: null,
            createdAt: at,
          },
        })
        .pipe(Effect.ignore);
    });
  const startWatch = (input: PullRequestWatchInput) =>
    Effect.gen(function* () {
      const thread = yield* readThread(input.threadId);
      if (!active(thread))
        return yield* new PullRequestWatchError({
          message: "Unarchive or unsettle the thread before watching a PR.",
        });
      const expectedStopGeneration = yield* store.stopGeneration(thread.id);
      const { ref, key } = yield* target(input);
      const existing = yield* store.get(thread.id, key);
      if (existing) return { threadId: thread.id, key, watch: existing.watch };
      const runtime = yield* (yield* federation()).resolve({ key });
      const detail = yield* runtime.provider.getDetail(ref);
      if (detail.state !== "open")
        return yield* new PullRequestWatchError({ message: "Only an open PR can be watched." });
      yield* runtime.hub.track({ url: detail.url, accountGeneration: runtime.account.generation });
      if (!active(yield* readThread(thread.id))) return yield* storageError();
      const now = yield* Clock.currentTimeMillis;
      const startedAt = new Date(now).toISOString();
      const row = yield* store.start({
        threadId: thread.id,
        key,
        accountId: runtime.account.id,
        expectedStopGeneration,
        watch: {
          startedAt,
          headSha: detail.headRefOid ?? null,
          failedChecks: [],
          passed: false,
          passedChecks: [],
          remarksThrough: new Date(Math.floor(now / 1000) * 1000).toISOString(),
          remarkIds: [],
          conflicting: false,
          wakes: 0,
        },
      });
      yield* changed(thread.id);
      return { threadId: thread.id, key, watch: row.watch };
    }).pipe(
      Effect.mapError((error) => (error instanceof PullRequestWatchError ? error : storageError())),
    );
  const stopWatch = (input: PullRequestWatchInput) =>
    readThread(input.threadId).pipe(
      Effect.andThen(
        Effect.suspend(() =>
          input.pr
            ? target(input).pipe(Effect.flatMap(({ key }) => stopThread(input.threadId, key)))
            : stopThread(input.threadId),
        ),
      ),
      Effect.mapError((error) => (error instanceof PullRequestWatchError ? error : storageError())),
    );

  const rateLimited = (cause: Cause.Cause<unknown>) => {
    const error = Cause.findErrorOption(cause);
    if (Option.isNone(error) || !error.value || typeof error.value !== "object") return null;
    const value = error.value as {
      kind?: unknown;
      rateLimit?: { resetAt?: string | null; retryAfterSeconds?: number | null };
      retryAfterSeconds?: number;
    };
    return value.kind === "rate_limited" ? value : null;
  };
  const failedRead = (
    rows: ReadonlyArray<PullRequestWatchRow>,
    cause: Cause.Cause<unknown>,
    now: number,
  ) =>
    Effect.gen(function* () {
      if (Cause.hasInterruptsOnly(cause)) return yield* Effect.interrupt;
      const limit = rateLimited(cause);
      const reset = limit?.rateLimit?.resetAt ? Date.parse(limit.rateLimit.resetAt) : NaN;
      const retryAt = Math.max(
        now + 120_000,
        Number.isFinite(reset)
          ? reset
          : now + (limit?.rateLimit?.retryAfterSeconds ?? limit?.retryAfterSeconds ?? 120) * 1000,
      );
      for (const row of rows) {
        if (!limit && row.readFailures >= 7) {
          if (yield* removeWatch(row)) {
            yield* changed(row.threadId);
            yield* notice(
              row,
              "Stopped watching the PR after eight failed reads. Check the forge and restart the watch to try again.",
            );
          }
        } else
          yield* store.failure(
            row,
            new Date(now).toISOString(),
            new Date(retryAt).toISOString(),
            !!limit,
          );
      }
    });
  const recordReport = (
    row: PullRequestWatchRow,
    detail: Parameters<typeof evaluatePullRequestWatch>[1] & {
      number: number;
      url: string;
      baseBranch: string | null;
    },
    remarks: Parameters<typeof evaluatePullRequestWatch>[2],
    now: number,
  ) =>
    Effect.gen(function* () {
      const report = evaluatePullRequestWatch(row.watch, detail, remarks);
      const at = new Date(now).toISOString();
      if (Buffer.byteLength(JSON.stringify(report.next), "utf8") > 65536) {
        if (yield* removeWatch(row)) {
          yield* changed(row.threadId);
          yield* notice(
            row,
            "Stopped watching because the PR activity exceeds the bounded watch state. Review the PR directly before restarting.",
          );
        }
        return false;
      }
      const message = pullRequestWatchMessage({
        number: detail.number,
        url: detail.url,
        baseBranch: detail.baseBranch ?? "the base branch",
        headSha: report.next.headSha,
        report,
      });
      const applied = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const current = yield* store.get(row.threadId, row.key);
            if (!current || current.watchId !== row.watchId || current.version !== row.version)
              return false;
            const thread = yield* readThread(row.threadId);
            if (!active(thread)) return false;
            const updated = report.exhausted
              ? yield* store.stopExpected(row)
              : yield* store.replace(row, report.next, at);
            if (!updated) return false;
            if (report.changes.length) {
              const id = CommandId.makeUnsafe(`watch:${row.watchId}:${row.version}`);
              const command = {
                type: "thread.turn.start" as const,
                commandId: id,
                threadId: row.threadId,
                message: {
                  messageId: MessageId.makeUnsafe(id),
                  role: "user" as const,
                  text: message.text,
                  attachments: [],
                },
                model: thread.model,
                ...(thread.modelSelection ? { modelSelection: thread.modelSelection } : {}),
                runtimeMode: thread.runtimeMode,
                interactionMode: thread.interactionMode,
                presentation: "continuation" as const,
                createdAt: at,
              };
              yield* queue.insertSubmission({
                submissionId: id,
                itemId: id,
                command,
                submissionSource: "automation",
                scheduleReason: "pull_request_watch",
                requestHash: canonicalRequestHash(command),
                atHead: false,
              });
            }
            return true;
          }),
        )
        .pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              if (Cause.hasInterruptsOnly(cause)) return yield* Effect.interrupt;
              // The state and queued message roll back together. The hard wake limit still stops a chatty watch.
              if (report.exhausted && (yield* removeWatch(row))) {
                yield* changed(row.threadId);
                yield* notice(row, "Stopped watching after ten comment-only updates in a row.");
              }
              return false;
            }),
          ),
        );
      if (applied) {
        yield* changed(row.threadId);
        if (report.changes.length) yield* dispatcher.notify(row.threadId);
      }
      return applied;
    });
  const readGroup = (key: string, rows: ReadonlyArray<PullRequestWatchRow>) =>
    Effect.gen(function* () {
      const first = rows[0]!;
      const ref = parseSourceControlPullRequestKey(first.key);
      if (!ref) return;
      const now = yield* Clock.currentTimeMillis;
      const runtime = yield* (yield* federation()).resolve({
        key: first.key,
        accountId: first.accountId,
      });
      const fingerprintExit = runtime.github
        ? yield* readGitHubWatchFingerprint(runtime.github, ref, config.cwd).pipe(Effect.exit)
        : null;
      if (
        fingerprintExit &&
        Exit.isFailure(fingerprintExit) &&
        rateLimited(fingerprintExit.cause)
      ) {
        yield* failedRead(rows, fingerprintExit.cause, now);
        return;
      }
      const fingerprint: PullRequestWatchFingerprint | null =
        fingerprintExit && Exit.isSuccess(fingerprintExit) ? fingerprintExit.value : null;
      const snapshot = yield* runtime.hub.getSnapshot;
      const tracked = [...snapshot.pullRequests, ...snapshot.recentlyResolved].find(
        (pr) => pr.key === first.key,
      );
      const snapshotKey = tracked
        ? JSON.stringify([
            tracked.headRefOid,
            tracked.state,
            tracked.updatedAt,
            tracked.checkRollup,
            tracked.mergeable,
          ])
        : "";
      const last = lastReads.get(key);
      const newWatch = rows.some((row) => !last?.watches.has(row.watchId));
      const activity =
        !last ||
        newWatch ||
        !last.remarksComplete ||
        (fingerprint
          ? last.remarks !== fingerprint.remarks || now - last.at >= 30 * 60_000
          : last.snapshot !== snapshotKey || last.inFlight || now - last.at >= 10 * 60_000);
      const detailNeeded =
        activity || !last || last.inFlight || (fingerprint && last.status !== fingerprint.status);
      if (!detailNeeded) {
        yield* Effect.logDebug("PR watch remains quiet", {
          pullRequest: first.key,
          quietForMs: now - last.at,
        });
        return;
      }
      const target = { key: first.key, accountGeneration: runtime.account.generation };
      const read = yield* Effect.all(
        {
          detail: runtime.hub.getDetail({ ...target, mode: "force" }),
          remarks: activity
            ? readPullRequestWatchRemarks({
                hub: runtime.hub,
                ...target,
                github: !!runtime.github,
              }).pipe(
                Effect.catch((error) =>
                  error.kind === "unsupported" ? Effect.succeed(null) : Effect.fail(error),
                ),
              )
            : Effect.succeed(null),
        },
        { concurrency: 2 },
      ).pipe(Effect.timeout("60 seconds"), Effect.exit);
      if (Exit.isFailure(read)) {
        lastReads.delete(key);
        yield* failedRead(rows, read.cause, now);
        return;
      }
      if (read.value.detail.stale) {
        lastReads.delete(key);
        yield* failedRead(
          rows,
          Cause.fail(
            read.value.detail.readErrorKind === "rate_limited"
              ? { kind: "rate_limited", rateLimit: read.value.detail.rateLimit }
              : storageError(),
          ),
          now,
        );
        return;
      }
      // Revalidate the account incarnation before publishing remote facts or queued work.
      yield* (yield* federation()).resolve({
        key: first.key,
        accountId: first.accountId,
        accountGeneration: runtime.account.generation,
      });
      const detail = read.value.detail.detail;
      if (detail.state !== "open") {
        lastReads.delete(key);
        for (const row of rows)
          if (yield* removeWatch(row)) {
            yield* changed(row.threadId);
            yield* notice(row, `Stopped watching the ${detail.state} PR.`);
          }
        return;
      }
      lastReads.set(key, {
        at: activity || !last ? now : last.at,
        status: fingerprint?.status ?? null,
        remarks: fingerprint?.remarks ?? null,
        snapshot: snapshotKey,
        watches: new Set(rows.map((row) => row.watchId)),
        inFlight:
          detail.mergeable === "unknown" ||
          detail.checks.some((check) => check.status === "pending"),
        remarksComplete: activity ? read.value.remarks !== null : (last?.remarksComplete ?? false),
      });
      const normalized = {
        headSha: detail.providerDetails.headRefOid,
        checks: detail.truncatedSections?.includes("checks")
          ? []
          : detail.checks.map((check) => ({ ...check, name: check.name.trim() || "Check" })),
        mergeability: detail.mergeable,
        viewer: runtime.account.login,
        author: detail.author,
        number: ref.number,
        url: detail.url,
        baseBranch: detail.baseRefName,
      };
      for (const row of rows)
        if (!(yield* recordReport(row, normalized, read.value.remarks, now))) lastReads.delete(key);
    }).pipe(
      Effect.provideService(GitHubRequestPriority, "cold"),
      Effect.provideService(GitHubSyncWait, false),
    );
  const sweep = gate
    .withPermits(1)(
      Effect.gen(function* () {
        const model = yield* engine.getReadModel();
        const threads = new Map(model.threads.map((thread) => [thread.id, thread]));
        const now = yield* Clock.currentTimeMillis;
        const due = yield* store.due(new Date(now).toISOString());
        const groups = new Map<string, PullRequestWatchRow[]>();
        for (const row of due) {
          const thread = threads.get(row.threadId);
          if (!thread || !active(thread)) {
            yield* stopThread(row.threadId, row.key);
            continue;
          }
          const key = JSON.stringify([row.accountId, row.key]);
          const group = groups.get(key) ?? [];
          group.push(row);
          groups.set(key, group);
        }
        for (const key of lastReads.keys()) if (!groups.has(key)) lastReads.delete(key);
        yield* Effect.forEach(
          [...groups],
          ([key, rows]) =>
            readGroup(key, rows).pipe(
              Effect.catchCause((cause) => {
                lastReads.delete(key);
                return failedRead(rows, cause, now);
              }),
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.interrupt
                  : Effect.logWarning("PR watch check could not complete"),
              ),
            ),
          { concurrency: 4, discard: true },
        );
      }),
    )
    .pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("PR watch sweep could not complete"),
      ),
      Effect.withSpan("PullRequestWatch.sweep"),
    );
  const start = Effect.gen(function* () {
    yield* Stream.runForEach(engine.streamDomainEvents, (event) =>
      [
        "thread.archived",
        "thread.deleted",
        "thread.turn-interrupt-requested",
        "thread.session-stop-requested",
        "thread.settled",
      ].includes(event.type)
        ? stopThread(ThreadId.makeUnsafe(event.aggregateId)).pipe(
            Effect.andThen(changed(ThreadId.makeUnsafe(event.aggregateId))),
            Effect.andThen(dispatcher.notify(ThreadId.makeUnsafe(event.aggregateId))),
            Effect.catchCause(() => Effect.logWarning("PR watches could not be stopped")),
          )
        : Effect.void,
    ).pipe(Effect.forkScoped);
    yield* sweep.pipe(Effect.repeat(Schedule.spaced("2 minutes")), Effect.forkScoped);
  });
  return {
    list,
    startWatch,
    stopWatch,
    stopThread,
    sweep,
    start,
    changes: Stream.fromPubSub(changes),
  };
});

export const PullRequestWatchServiceLive = Layer.effect(
  PullRequestWatchService,
  makePullRequestWatchService,
);
