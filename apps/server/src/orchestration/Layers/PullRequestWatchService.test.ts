import { TestClock } from "effect/testing";
import { assert, it } from "@effect/vitest";
import { Clock, Deferred, Effect, Fiber, Layer, Schema, Stream, type Scope } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  OrchestrationThread,
  ProjectId,
  PullRequestKey,
  ThreadId,
  type PrHubCheck,
  type PrHubTimelineComment,
} from "@t3tools/contracts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeNextTurnQueueStore } from "../../nextTurnQueue/Layers/NextTurnQueueStore.ts";
import { NextTurnQueueStore } from "../../nextTurnQueue/Services/NextTurnQueueStore.ts";
import { NextTurnQueueDispatcher } from "../../nextTurnQueue/Services/NextTurnQueueDispatcher.ts";
import { NextTurnQueueStorageError } from "../../nextTurnQueue/Errors.ts";
import { readSubmissionSource } from "../../provider/submissionProvenance.ts";
import { makeForgeSourceControlProvider } from "../../sourceControl/ForgeSourceControlProvider.ts";
import { SourceControlProviderError } from "../../sourceControl/SourceControlProvider.ts";
import { makeForgePrHubService } from "../../prHub/forgeHub.ts";
import { forgeDetail, forgeTracked } from "../../prHub/forgeModel.ts";
import { PrHubFederation } from "../../prHub/Layers/PrHubFederation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { makePullRequestWatchStore } from "../PullRequestWatchStore.ts";
import { makePullRequestWatchService } from "./PullRequestWatchService.ts";

const key = PullRequestKey.makeUnsafe("gitlab:gitlab.example/team/repo#7");
const ref = {
  provider: "gitlab" as const,
  host: "gitlab.example",
  repository: "team/repo",
  number: 7,
};
const threadId = ThreadId.makeUnsafe("watch-one");
const otherId = ThreadId.makeUnsafe("watch-two");
const pageInfo = { hasNextPage: false, endCursor: null, truncated: false };
const fixture = Effect.gen(function* () {
  yield* TestClock.setTime(Date.parse("2026-10-19T12:00:00.000Z"));
  const sql = yield* SqlClient.SqlClient;
  const now = new Date(yield* Clock.currentTimeMillis).toISOString();
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,default_model,scripts_json,created_at,updated_at,deleted_at) VALUES('watch-project','Project','/tmp',NULL,'[]',${now},${now},NULL)`;
  const threads = [threadId, otherId].map((id) =>
    Schema.decodeUnknownSync(OrchestrationThread)({
      id,
      projectId: ProjectId.makeUnsafe("watch-project"),
      title: "Watch",
      model: "gpt-5.1-codex",
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      archivedAt: null,
      createdAt: now,
      lastInteractionAt: now,
      updatedAt: now,
      deletedAt: null,
      messages: [],
      tasks: [],
      tasksTurnId: null,
      tasksUpdatedAt: null,
      activities: [],
      checkpoints: [],
      session: null,
    }),
  );
  for (const thread of threads)
    yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model,branch,worktree_path,latest_turn_id,archived_at,created_at,last_interaction_at,updated_at,deleted_at) VALUES(${thread.id},${thread.projectId},${thread.title},${thread.model},NULL,NULL,NULL,NULL,${now},${now},${now},NULL)`;
  const account = {
    id: "one",
    generation: "gen-1",
    provider: "gitlab" as const,
    host: "gitlab.example",
    login: "alice",
    viewerId: "42",
  };
  const provider = makeForgeSourceControlProvider({
    kind: "gitlab",
    resolveAccount: () =>
      Effect.succeed({
        kind: "gitlab",
        host: account.host,
        repository: "team/repo",
        login: "alice",
        token: "private",
      }),
    fetch: (async () =>
      Response.json({
        iid: 7,
        title: "Change",
        source_branch: "topic",
        target_branch: "main",
        state: "opened",
        sha: "head",
        diff_refs: { head_sha: "head", base_sha: "base" },
        web_url: "https://gitlab.example/team/repo/-/merge_requests/7",
      })) as unknown as typeof fetch,
  });
  const nativeHub = yield* makeForgePrHubService(account, provider);
  const source = yield* provider.getDetail(ref);
  const detail = forgeDetail(forgeTracked(account, ref, source, provider), source);
  const delayed = yield* Deferred.make<void>();
  const entered = yield* Deferred.make<void>();
  const state = {
    checks: [] as PrHubCheck[],
    comments: [] as PrHubTimelineComment[],
    calls: 0,
    fail: false,
    rateLimited: false,
    queueFail: false,
    delay: false,
    closed: false,
    quiet: false,
    generation: "gen-1",
    notices: [] as string[],
    notified: [] as ThreadId[],
  };
  const hub = {
    ...nativeHub,
    getDetail: () =>
      Effect.gen(function* () {
        state.calls++;
        yield* Deferred.succeed(entered, undefined);
        if (state.delay) yield* Deferred.await(delayed);
        if (state.fail)
          return yield* new SourceControlProviderError({
            provider: "gitlab",
            kind: state.rateLimited ? "rate_limited" : "network",
            operation: "test",
            detail: "private-do-not-leak",
            ...(state.rateLimited
              ? {
                  rateLimit: {
                    resetAt: new Date((yield* Clock.currentTimeMillis) + 300_000).toISOString(),
                  },
                }
              : {}),
          });
        return {
          ...detail,
          detail: {
            ...detail.detail,
            state: state.closed ? ("merged" as const) : ("open" as const),
            checks: state.checks,
            mergeable: state.quiet ? ("mergeable" as const) : ("unknown" as const),
          },
        };
      }),
    getTimeline: () =>
      Effect.succeed({ entries: state.comments, pageInfo, refreshedAt: now, stale: false }),
    getReviewThreads: () =>
      Effect.succeed({ threads: [], pageInfo, comparisonVersion: "head:base", refreshedAt: now }),
  };
  const store = yield* makeNextTurnQueueStore;
  const watches = yield* makePullRequestWatchStore;
  const create = () =>
    makePullRequestWatchService.pipe(
      Effect.provideService(PrHubFederation, {
        hub,
        parseUrl: () => Effect.succeed(ref),
        resolve: (input: { accountGeneration?: string | undefined }) =>
          input.accountGeneration && input.accountGeneration !== state.generation
            ? Effect.fail(
                new SourceControlProviderError({
                  provider: "gitlab",
                  kind: "forbidden",
                  operation: "test",
                  detail: "Account changed",
                }),
              )
            : Effect.succeed({
                account: { ...account, generation: state.generation },
                provider,
                hub,
              }),
      }),
      Effect.provide(
        Layer.mock(OrchestrationEngineService)({
          getReadModel: () =>
            Effect.succeed({
              threads,
              projects: [],
              snapshotSequence: 0,
              planningWorkflows: [],
              codeReviewWorkflows: [],
              investigationWorkflows: [],
              updatedAt: now,
            }),
          streamDomainEvents: Stream.empty,
          readEvents: () => Stream.empty,
          dispatch: (command) =>
            Effect.sync(() => {
              if (command.type === "thread.activity.append")
                state.notices.push(command.activity.summary);
              return { sequence: 1 };
            }),
        }),
      ),
      Effect.provideService(NextTurnQueueStore, {
        ...store,
        insertSubmission: (input) =>
          state.queueFail
            ? Effect.fail(new NextTurnQueueStorageError({ message: "Queue unavailable" }))
            : store.insertSubmission(input),
      }),
      Effect.provide(
        Layer.mock(NextTurnQueueDispatcher)({
          changes: Stream.empty,
          summaryChanges: Stream.empty,
          notify: (id) =>
            Effect.sync(() => {
              state.notified.push(id);
            }),
        }),
      ),
    );
  const service = yield* create();
  const input = { threadId, pr: key };
  const items = () => store.listByThread(threadId).pipe(Effect.map((data) => data.items));
  const comment = (id: string, createdAt: string): PrHubTimelineComment => ({
    type: "comment",
    id,
    databaseId: null,
    kind: "issue-comment",
    author: { login: "bot", name: null, avatarUrl: null },
    body: "Review update",
    createdAt,
    updatedAt: createdAt,
    url: source.url,
    path: null,
    line: null,
    reviewState: null,
    viewerCanUpdate: false,
    reactions: [],
  });
  return {
    sql,
    threads,
    state,
    service,
    create,
    store,
    watches,
    input,
    items,
    delayed,
    entered,
    comment,
  };
});
function run<A, E>(
  test: (
    f: Effect.Success<typeof fixture>,
  ) => Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope | ServerConfig>,
) {
  return Effect.scoped(fixture.pipe(Effect.flatMap(test))).pipe(
    Effect.provide(
      Layer.mergeAll(
        SqlitePersistenceMemory,
        ServerSettingsService.layerTest(),
        ServerConfig.layerTest(process.cwd(), { prefix: "f5-pr-watches-" }),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  );
}
it.effect(
  "shares a PR read across threads and persists each wake with trusted automation provenance",
  () =>
    run((f) =>
      Effect.gen(function* () {
        yield* f.service.startWatch(f.input);
        yield* f.service.startWatch(f.input);
        yield* f.service.startWatch({ threadId: otherId, pr: key });
        f.state.checks = [
          { name: "required", status: "success", description: null, url: null, required: true },
        ];
        yield* f.service.sweep;
        assert.equal(f.state.calls, 1);
        const items = yield* f.items();
        assert.lengthOf(items, 1);
        assert.equal(items[0]?.command.presentation, "continuation");
        assert.equal(
          yield* readSubmissionSource(items[0]!.command.commandId, threadId),
          "automation",
        );
        assert.lengthOf((yield* f.store.listByThread(otherId)).items, 1);
        yield* f.service.sweep;
        assert.lengthOf(yield* f.items(), 1);
      }),
    ),
);
it.effect("rolls back watch state when queue admission fails and retries the same change", () =>
  run((f) =>
    Effect.gen(function* () {
      yield* f.service.startWatch(f.input);
      f.state.checks = [{ name: "CI", status: "failure", description: null, url: null }];
      f.state.queueFail = true;
      yield* f.service.sweep;
      assert.deepStrictEqual((yield* f.watches.get(threadId, key))?.watch.failedChecks, []);
      assert.lengthOf(yield* f.items(), 0);
      f.state.queueFail = false;
      yield* f.service.sweep;
      assert.deepStrictEqual((yield* f.watches.get(threadId, key))?.watch.failedChecks, ["CI"]);
      assert.lengthOf(yield* f.items(), 1);
    }),
  ),
);
it.effect("rejects a late result after stop/restart and cancels queued wakes on Stop", () =>
  run((f) =>
    Effect.gen(function* () {
      yield* f.service.startWatch(f.input);
      f.state.checks = [{ name: "CI", status: "failure", description: null, url: null }];
      f.state.delay = true;
      const polling = yield* f.service.sweep.pipe(Effect.forkChild);
      yield* Deferred.await(f.entered);
      yield* f.service.stopWatch(f.input);
      yield* f.service.startWatch(f.input);
      yield* Deferred.succeed(f.delayed, undefined);
      yield* Fiber.join(polling);
      assert.lengthOf(yield* f.items(), 0);
      yield* f.service.sweep;
      assert.lengthOf(yield* f.items(), 1);
      yield* f.service.stopWatch({ threadId });
      assert.lengthOf(yield* f.items(), 0);
      assert.lengthOf(yield* f.service.list(threadId), 0);
    }),
  ),
);
it.effect(
  "rate limits pause without failure credit; eight failed reads stop and explain the watch",
  () =>
    run((f) =>
      Effect.gen(function* () {
        yield* f.service.startWatch(f.input);
        f.state.fail = true;
        f.state.rateLimited = true;
        yield* f.service.sweep;
        assert.equal((yield* f.watches.get(threadId, key))?.readFailures, 0);
        yield* f.service.sweep;
        assert.equal(f.state.calls, 1);
        yield* TestClock.adjust("5 minutes");
        f.state.rateLimited = false;
        for (let i = 0; i < 8; i++) {
          yield* f.service.sweep;
          yield* TestClock.adjust("2 minutes");
        }
        assert.lengthOf(yield* f.service.list(threadId), 0);
        assert.match(f.state.notices[0]!, /eight failed reads/);
        assert.isFalse(f.state.notices.join().includes("private-do-not-leak"));
      }),
    ),
);
it.effect("stops a merged PR or inactive thread and retains the stop across service restart", () =>
  run((f) =>
    Effect.gen(function* () {
      yield* f.service.startWatch(f.input);
      f.state.closed = true;
      yield* f.service.sweep;
      assert.lengthOf(yield* f.service.list(threadId), 0);
      f.state.closed = false;
      yield* f.service.startWatch(f.input);
      f.threads[0] = {
        ...f.threads[0]!,
        archivedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
      };
      yield* f.service.sweep;
      const restarted = yield* f.create();
      assert.lengthOf(yield* restarted.list(threadId), 0);
      assert.isTrue((yield* restarted.startWatch(f.input).pipe(Effect.result))._tag === "Failure");
    }),
  ),
);
it.effect("stops after ten consecutive comment-only wakes even when the last enqueue fails", () =>
  run((f) =>
    Effect.gen(function* () {
      yield* f.service.startWatch(f.input);
      for (let i = 0; i < 10; i++) {
        yield* TestClock.adjust("2 minutes");
        f.state.comments.push(
          f.comment(`comment-${i}`, new Date(yield* Clock.currentTimeMillis).toISOString()),
        );
        f.state.queueFail = i === 9;
        yield* f.service.sweep;
      }
      assert.lengthOf(yield* f.service.list(threadId), 0);
      assert.match(f.state.notices[0]!, /ten comment-only/);
      assert.lengthOf(yield* f.items(), 0);
    }),
  ),
);

it.effect("does not publish a poll completed by a replaced account incarnation", () =>
  run((f) =>
    Effect.gen(function* () {
      yield* f.service.startWatch(f.input);
      f.state.checks = [{ name: "CI", status: "failure", description: null, url: null }];
      f.state.delay = true;
      const poll = yield* f.service.sweep.pipe(Effect.forkChild);
      yield* Deferred.await(f.entered);
      f.state.generation = "gen-2";
      yield* Deferred.succeed(f.delayed, undefined);
      yield* Fiber.join(poll);
      assert.lengthOf(yield* f.items(), 0);
      assert.deepStrictEqual((yield* f.watches.get(threadId, key))?.watch.failedChecks, []);
    }),
  ),
);
it.effect("skips quiet forge reads and forces an activity refresh after ten minutes", () =>
  run((f) =>
    Effect.gen(function* () {
      yield* f.service.startWatch(f.input);
      f.state.quiet = true;
      yield* f.service.sweep;
      assert.equal(f.state.calls, 1);
      yield* TestClock.adjust("2 minutes");
      yield* f.service.sweep;
      assert.equal(f.state.calls, 1);
      f.state.comments = [
        f.comment("late", new Date(yield* Clock.currentTimeMillis).toISOString()),
      ];
      yield* TestClock.adjust("8 minutes");
      yield* f.service.sweep;
      assert.equal(f.state.calls, 2);
      assert.lengthOf(yield* f.items(), 1);
    }),
  ),
);
