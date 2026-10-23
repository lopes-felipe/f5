import { GitManager } from "../../git/Services/GitManager.ts";
import { GitManagerError } from "../../git/Errors.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  PullRequestKey,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Clock, Effect, Layer, Queue, Stream, type Scope } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { NextTurnQueueDispatcher } from "../../nextTurnQueue/Services/NextTurnQueueDispatcher.ts";
import { makeNextTurnQueueStore } from "../../nextTurnQueue/Layers/NextTurnQueueStore.ts";
import { stampSubmissionSource } from "../../provider/submissionProvenance.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { makePullRequestWatchStore } from "../PullRequestWatchStore.ts";
import { makeForgeSourceControlProvider } from "../../sourceControl/ForgeSourceControlProvider.ts";
import { SourceControlProviderError } from "../../sourceControl/SourceControlProvider.ts";
import { makeForgePrHubService } from "../../prHub/forgeHub.ts";
import { forgeDetail, forgeTracked } from "../../prHub/forgeModel.ts";
import { PrHubFederation } from "../../prHub/Layers/PrHubFederation.ts";
import { PrHubExtensions } from "../../prHub/PrHubExtensions.ts";
import { makeThreadSettlementService } from "./ThreadSettlementService.ts";

const threadId = ThreadId.makeUnsafe("settlement-thread");
const projectId = ProjectId.makeUnsafe("settlement-project");
const old = "2026-10-01T12:00:00.000Z";
const key = PullRequestKey.makeUnsafe("github:github.com/org/repo#1");
const engineLayer = OrchestrationEngineLive.pipe(
  Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(OrchestrationProjectionPipelineLive),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
);
const makeFixture = (savedBranch: string | null = null) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const sql = yield* SqlClient.SqlClient;
    const snapshots = yield* ProjectionSnapshotQuery;
    const settings = yield* ServerSettingsService;
    const queue = yield* makeNextTurnQueueStore;
    const watches = yield* makePullRequestWatchStore;
    const makeService = makeThreadSettlementService.pipe(
      Effect.provide(
        Layer.mock(NextTurnQueueDispatcher)({
          changes: Stream.empty,
          summaryChanges: Stream.empty,
        }),
      ),
    );
    const service = yield* makeService;
    let index = 0;
    const dispatch = (command: Omit<OrchestrationCommand, "commandId">) =>
      engine.dispatch({
        ...command,
        commandId: CommandId.makeUnsafe(`settle-${index++}`),
      } as OrchestrationCommand);
    yield* dispatch({
      type: "project.create",
      projectId,
      title: "Project",
      workspaceRoot: "/tmp/settlement-test",
      createdAt: old,
    } as Omit<Extract<OrchestrationCommand, { type: "project.create" }>, "commandId">);
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.makeUnsafe("create-thread"),
      threadId,
      projectId,
      title: "Thread",
      model: "gpt-5.1-codex",
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: savedBranch,
      worktreePath: null,
      createdAt: old,
    });
    const thread = () =>
      engine
        .getReadModel()
        .pipe(Effect.map((model) => model.threads.find((thread) => thread.id === threadId)!));
    const settle = () =>
      engine.dispatch({
        type: "thread.settle",
        commandId: CommandId.makeUnsafe(`settle-${index++}`),
        threadId,
        createdAt: new Date().toISOString(),
      });
    const watch = () =>
      watches.start({
        threadId,
        key,
        accountId: "account",
        watch: {
          startedAt: old,
          headSha: "head",
          failedChecks: [],
          passed: false,
          passedChecks: [],
          remarksThrough: old,
          remarkIds: [],
          conflicting: false,
          wakes: 0,
        },
      });
    return {
      engine,
      sql,
      snapshots,
      settings,
      queue,
      watches,
      service,
      makeService,
      thread,
      settle,
      watch,
    };
  });
const fixture = makeFixture();
function run<A, E>(
  test: (
    f: Effect.Success<typeof fixture>,
  ) => Effect.Effect<
    A,
    E,
    | SqlClient.SqlClient
    | Scope.Scope
    | OrchestrationEngineService
    | ServerConfig
    | ServerSettingsService
  >,
  savedBranch: string | null = null,
) {
  // Set the clock before the engine starts: its periodic delivery check would
  // otherwise replay every one-second tick between the epoch and this date.
  return TestClock.setTime(Date.parse("2026-10-19T12:00:00.000Z")).pipe(
    Effect.andThen(
      Effect.scoped(makeFixture(savedBranch).pipe(Effect.flatMap(test))).pipe(
        Effect.provide(
          engineLayer.pipe(
            Layer.provideMerge(SqlitePersistenceMemory),
            Layer.provideMerge(ServerSettingsService.layerTest()),
            Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "f5-settlement-" })),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    ),
  );
}
it.effect("persists settlement and auto-settle preference in full and lightweight snapshots", () =>
  run((f) =>
    Effect.gen(function* () {
      yield* f.engine.dispatch({
        type: "thread.auto-settle.set",
        commandId: CommandId.makeUnsafe("disable"),
        threadId,
        enabled: false,
        createdAt: old,
      });
      yield* f.settle();
      assert.equal((yield* f.thread()).settledBy, "user");
      assert.isTrue((yield* f.thread()).autoSettleDisabled);
      const snapshot = yield* f.snapshots.getSnapshot();
      assert.equal(snapshot.threads[0]?.settledAt, (yield* f.thread()).settledAt);
      assert.isTrue(snapshot.threads[0]?.autoSettleDisabled);
      const startup = yield* f.snapshots.getStartupSnapshot();
      assert.equal(startup.snapshot.threads[0]?.settledBy, "user");
    }),
  ),
);
it.effect("stops watches transactionally when a user settles and refuses a new watch", () =>
  run((f) =>
    Effect.gen(function* () {
      yield* f.watch();
      yield* f.settle();
      assert.lengthOf(yield* f.watches.list(threadId), 0);
      assert.equal((yield* f.watch().pipe(Effect.result))._tag, "Failure");
    }),
  ),
);
it.effect(
  "unsettles in the same transaction as a new turn, before its message and start events",
  () =>
    run((f) =>
      Effect.gen(function* () {
        yield* f.settle();
        const before = (yield* f.engine.getReadModel()).snapshotSequence;
        yield* f.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("wake"),
          threadId,
          message: {
            messageId: MessageId.makeUnsafe("wake-message"),
            role: "user",
            text: "More work",
            attachments: [],
          },
          model: "gpt-5.1-codex",
          runtimeMode: "approval-required",
          interactionMode: "default",
          createdAt: "2026-10-19T12:01:00.000Z",
        });
        assert.isNull((yield* f.thread()).settledAt);
        const events = yield* Stream.runCollect(f.engine.readEvents(before));
        assert.deepStrictEqual(
          events.slice(0, 3).map((event) => event.type),
          ["thread.unsettled", "thread.message-sent", "thread.turn-start-requested"],
        );
        assert.isNull((yield* f.snapshots.getSnapshot()).threads[0]?.settledAt);
      }),
    ),
);
it.effect("checks queued work and pending requests inside the settlement command transaction", () =>
  run((f) =>
    Effect.gen(function* () {
      const id = CommandId.makeUnsafe("queue-settle");
      yield* f.queue.insertSubmission({
        submissionId: id,
        itemId: id,
        requestHash: "queue",
        atHead: false,
        command: {
          type: "thread.turn.start",
          commandId: id,
          threadId,
          message: {
            messageId: MessageId.makeUnsafe("queued"),
            role: "user",
            text: "Pending",
            attachments: [],
          },
          model: "gpt-5.1-codex",
          runtimeMode: "approval-required",
          interactionMode: "default",
          createdAt: old,
        },
      });
      // The rejection names what to clear first.
      const reason = () =>
        f.settle().pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        );
      assert.include(yield* reason(), "has a queued message. Send it or remove it");
      yield* f.queue.softDelete({ itemId: id });
      yield* f.sql`INSERT INTO projection_pending_user_inputs(thread_id,request_id,payload_json,resolution) VALUES(${threadId},'input','{}',NULL)`;
      assert.include(yield* reason(), "waiting on an approval or question. Answer it");
      yield* f.sql`DELETE FROM projection_pending_user_inputs WHERE thread_id=${threadId}`;
      yield* f.settle();
      assert.isNotNull((yield* f.thread()).settledAt);
    }),
  ),
);
it.effect(
  "automatically settles only opted-in idle threads, preserving the last activity as settled-at",
  () =>
    run((f) =>
      Effect.gen(function* () {
        yield* f.service.sweep;
        assert.isNull((yield* f.thread()).settledAt);
        yield* f.settings.updateSettings({ autoSettleAfterDays: 7 });
        yield* f.service.sweep;
        assert.equal((yield* f.thread()).settledAt, old);
        assert.equal((yield* f.thread()).settledBy, "auto");
      }),
    ),
);
it.effect("an active watch blocks automatic and bulk idle settlement", () =>
  run((f) =>
    Effect.gen(function* () {
      yield* f.settings.updateSettings({ autoSettleAfterDays: 7 });
      yield* f.watch();
      yield* f.service.sweep;
      assert.isNull((yield* f.thread()).settledAt);
      assert.equal((yield* f.service.settleProjectIdle(projectId)).settled, 0);
    }),
  ),
);
it.effect("excludes positively identified automation from the human-message timestamp", () =>
  run((f) =>
    Effect.gen(function* () {
      const commandId = CommandId.makeUnsafe("automatic");
      yield* stampSubmissionSource(commandId, threadId, "automation");
      yield* f.engine.dispatch({
        type: "thread.turn.start",
        commandId,
        threadId,
        message: {
          messageId: MessageId.makeUnsafe("different-message-id"),
          role: "user",
          text: "Automatic update",
          attachments: [],
        },
        model: "gpt-5.1-codex",
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt: "2026-10-19T12:00:00.000Z",
      });
      assert.isNull(
        (yield* f.service.readCandidate(yield* f.thread())).latestUserAuthoredMessageAt,
      );
      const authors = yield* f.sql<{
        source: string;
      }>`SELECT source FROM thread_message_authorship WHERE message_id='different-message-id'`;
      assert.equal(authors[0]?.source, "automation");
    }),
  ),
);
it.effect("defers an agent settlement intent and cancels it when Stop commits", () =>
  run((f) =>
    Effect.gen(function* () {
      yield* f.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("session-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: TurnId.makeUnsafe("turn"),
          lastError: null,
          updatedAt: old,
        },
        createdAt: old,
      });
      assert.isTrue((yield* f.service.settleFromAgent(threadId)).deferred);
      assert.lengthOf(yield* f.sql`SELECT * FROM thread_settlement_requests`, 1);
      yield* f.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("stop"),
        threadId,
        createdAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
      });
      assert.lengthOf(yield* f.sql`SELECT * FROM thread_settlement_requests`, 0);
      assert.isNull((yield* f.thread()).settledAt);
    }),
  ),
);

it.effect(
  "persists wake anchors, cancels pending hooks atomically, and preserves orphan claims",
  () =>
    run((f) =>
      Effect.gen(function* () {
        yield* f.settle();
        const at = "2026-10-19T12:00:00.000Z";
        yield* f.sql`INSERT INTO thread_settlement_hooks(thread_id,job_id,settled_at,worktree_path,project_id,scripts_json,state,updated_at) VALUES(${threadId},'old',${old},'/tmp/wt',${projectId},'[]','pending',${old})`;
        yield* f.engine.dispatch({
          type: "thread.unsettle",
          commandId: CommandId.makeUnsafe("manual-wake"),
          threadId,
          createdAt: at,
        });
        assert.equal((yield* f.service.readCandidate(yield* f.thread())).lastUnsettledAt, at);
        assert.equal(
          (yield* f.sql<{ state: string }>`SELECT state FROM thread_settlement_hooks`)[0]?.state,
          "canceled",
        );
        yield* f.sql`UPDATE thread_settlement_hooks SET state='orphaned'`;
        assert.equal((yield* f.settle().pipe(Effect.result))._tag, "Failure");
        assert.equal(
          (yield* f.sql<{ state: string }>`SELECT state FROM thread_settlement_hooks`)[0]?.state,
          "orphaned",
        );
      }),
    ),
);
it.effect("waits for terminal processing before honoring an agent settlement request", () =>
  run((f) =>
    Effect.gen(function* () {
      const turnId = TurnId.makeUnsafe("agent-request-turn");
      const session = {
        threadId,
        status: "running" as const,
        providerName: "codex" as const,
        runtimeMode: "approval-required" as const,
        activeTurnId: turnId,
        lastError: null,
        updatedAt: old,
      };
      yield* f.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("agent-session"),
        threadId,
        session,
        createdAt: old,
      });
      assert.isTrue((yield* f.service.settleFromAgent(threadId)).deferred);
      yield* f.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("agent-done"),
        threadId,
        session: { ...session, status: "ready", activeTurnId: null },
        settledTurnId: turnId,
        createdAt: old,
      });
      yield* f.service.sweep;
      assert.isNull((yield* f.thread()).settledAt);
      yield* f.engine.dispatch({
        type: "thread.turn.processing.quiesce",
        commandId: CommandId.makeUnsafe("agent-quiesced"),
        threadId,
        turnId,
        processingQuiescedAt: old,
        createdAt: old,
      });
      yield* f.service.sweep;
      assert.equal((yield* f.thread()).settledBy, "agent");
      assert.lengthOf(yield* f.sql`SELECT * FROM thread_settlement_requests`, 0);
    }),
  ),
);
it.effect("checks pending approvals in the settlement transaction", () =>
  run((f) =>
    Effect.gen(function* () {
      yield* f.sql`INSERT INTO projection_pending_approvals(request_id,thread_id,status,created_at) VALUES('approval',${threadId},'pending',${old})`;
      assert.equal((yield* f.settle().pipe(Effect.result))._tag, "Failure");
      yield* f.sql`UPDATE projection_pending_approvals SET status='resolved'`;
      yield* f.settle();
      assert.isNotNull((yield* f.thread()).settledAt);
    }),
  ),
);

const prFixture = (
  f: Effect.Success<typeof fixture>,
  options?: { branch?: boolean; noLink?: boolean },
) =>
  Effect.gen(function* () {
    const ref = {
      provider: "gitlab" as const,
      host: "gitlab.example",
      repository: "team/repo",
      number: 7,
    };
    const url = "https://gitlab.example/team/repo/-/merge_requests/7";
    const account = {
      id: "one",
      generation: "gen-1",
      provider: "gitlab" as const,
      host: ref.host,
      login: "alice",
      viewerId: "42",
    };
    const provider = makeForgeSourceControlProvider({
      kind: "gitlab",
      resolveAccount: () =>
        Effect.succeed({
          kind: "gitlab",
          host: account.host,
          repository: ref.repository,
          login: "alice",
          token: "private",
        }),
      fetch: (async () =>
        Response.json({
          iid: 7,
          title: "Change",
          source_branch: "topic",
          target_branch: "main",
          state: "merged",
          sha: "head",
          diff_refs: { head_sha: "head", base_sha: "base" },
          merged_at: "2026-10-02T12:00:00.000Z",
          web_url: url,
        })) as unknown as typeof fetch,
    });
    const nativeHub = yield* makeForgePrHubService(account, provider);
    const source = yield* provider.getDetail(ref);
    const detail = forgeDetail(forgeTracked(account, ref, source, provider), source);
    const state = {
      reads: 0,
      tracks: 0,
      stale: false,
      changeAccount: false,
      generation: "gen-1",
      branchCalls: [] as string[],
      directReads: 0,
      branchState: "merged" as "open" | "merged" | "none" | "unknown",
      disableDuringRead: false,
      excludeDuringRead: false,
      directHead: "head",
    };
    const runtimeProvider = {
      ...provider,
      getDetail: (input: Parameters<typeof provider.getDetail>[0]) =>
        Effect.gen(function* () {
          state.directReads++;
          if (state.changeAccount) state.generation = "gen-2";
          if (state.disableDuringRead)
            yield* f.settings
              .updateSettings({ autoSettleOnPullRequestMerge: false })
              .pipe(Effect.orDie);
          if (state.excludeDuringRead)
            yield* f.settings
              .updateSettings({ prHub: { excludeRepos: ["team/repo"] } })
              .pipe(Effect.orDie);
          return { ...(yield* provider.getDetail(input)), headRefOid: state.directHead };
        }),
    };
    const hub = {
      ...nativeHub,
      track: (input: Parameters<typeof nativeHub.track>[0]) =>
        Effect.gen(function* () {
          state.tracks++;
          return yield* nativeHub.track(input);
        }),
      getDetail: () =>
        Effect.sync(() => {
          state.reads++;
          if (state.changeAccount) state.generation = "gen-2";
          return { ...detail, stale: state.stale };
        }),
    };
    const statusChanges = yield* Queue.unbounded<string>();
    const service = yield* f.makeService.pipe(
      Effect.provideService(PrHubFederation, {
        hub,
        parseUrl: () => Effect.succeed(ref),
        resolve: (input) =>
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
                provider: runtimeProvider,
                hub,
              }),
      }),
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(PrHubExtensions)({
            getThreadLinks: () => Effect.succeed([{ ...ref, url, title: "Change" }]),
          }),
          options?.branch
            ? Layer.mock(GitManager)({
                pullRequestStateChanges: Stream.fromQueue(statusChanges),
                branchPullRequest: (input) =>
                  Effect.gen(function* () {
                    state.branchCalls.push(input.branch);
                    if (state.branchState === "unknown")
                      return yield* new GitManagerError({
                        operation: "fixture",
                        detail: "Cannot verify branch identity.",
                      });
                    return state.branchState === "none"
                      ? null
                      : {
                          number: 7,
                          title: "Change",
                          url,
                          baseRefName: "main",
                          headRefName: input.branch,
                          headRefOid: "head",
                          state: state.branchState,
                        };
                  }),
              })
            : Layer.empty,
        ),
      ),
    );
    if (!options?.noLink)
      yield* f.sql`INSERT INTO projection_thread_pull_requests(link_id,thread_id,provider,host,repository,number,title,url,updated_at) VALUES('link',${threadId},${ref.provider},${ref.host},${ref.repository},7,'Change',${url},${old})`;
    return { service, state, statusChanges };
  });
it.effect(
  "tracks newly linked PRs, shares reads, and never reuses an old merge after manual wake",
  () =>
    run((f) =>
      Effect.gen(function* () {
        const pr = yield* prFixture(f);
        yield* pr.service.sweep;
        assert.equal(pr.state.reads, 0);
        yield* f.settings.updateSettings({ autoSettleOnPullRequestMerge: true });
        const other = ThreadId.makeUnsafe("shared-pr-thread");
        yield* f.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("create-shared-pr"),
          threadId: other,
          projectId,
          title: "Same PR",
          model: "gpt-5.1-codex",
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: old,
        });
        yield* f.sql`INSERT INTO projection_thread_pull_requests(link_id,thread_id,provider,host,repository,number,title,url,updated_at) SELECT 'other-link',${other},provider,host,repository,number,title,url,updated_at FROM projection_thread_pull_requests WHERE thread_id=${threadId}`;
        yield* pr.service.sweep;
        assert.equal(pr.state.reads, 1);
        assert.equal(pr.state.tracks, 1);
        assert.equal((yield* f.thread()).settledBy, "auto");
        assert.isNotNull(
          (yield* f.engine.getReadModel()).threads.find((thread) => thread.id === other)?.settledAt,
        );
        yield* f.engine.dispatch({
          type: "thread.unsettle",
          commandId: CommandId.makeUnsafe("wake-after-merge"),
          threadId,
          createdAt: "2026-10-19T12:00:00.000Z",
        });
        yield* pr.service.sweep;
        assert.isNull((yield* f.thread()).settledAt);
      }),
    ),
);
it.effect(
  "retains an active thread if PR details are stale or account generation changes during the read",
  () =>
    run((f) =>
      Effect.gen(function* () {
        const pr = yield* prFixture(f);
        yield* f.settings.updateSettings({ autoSettleOnPullRequestMerge: true });
        pr.state.stale = true;
        yield* pr.service.sweep;
        assert.isNull((yield* f.thread()).settledAt);
        pr.state.stale = false;
        pr.state.changeAccount = true;
        yield* pr.service.sweep;
        assert.isNull((yield* f.thread()).settledAt);
      }),
    ),
);

it.effect(
  "settles inactivity before contacting the PR host even when merge settlement is enabled",
  () =>
    run((f) =>
      Effect.gen(function* () {
        const pr = yield* prFixture(f);
        yield* f.settings.updateSettings({
          autoSettleAfterDays: 7,
          autoSettleOnPullRequestMerge: true,
          autoSettleKeepPullRequests: false,
        });
        yield* pr.service.sweep;
        assert.equal((yield* f.thread()).settledAt, old);
        assert.equal(pr.state.reads, 0);
        assert.equal(pr.state.tracks, 0);
      }),
    ),
);

function runWithBranch<A, E>(test: Parameters<typeof run<A, E>>[0]) {
  return run(test, "topic");
}

it.effect(
  "settles an unlinked branch from verified terminal details without adding it to PR Hub",
  () =>
    runWithBranch((f) =>
      Effect.gen(function* () {
        const pr = yield* prFixture(f, { branch: true, noLink: true });
        yield* pr.service.sweep;
        assert.deepEqual(pr.state.branchCalls, []);
        assert.equal(pr.state.directReads, 0);
        yield* f.settings.updateSettings({ autoSettleOnPullRequestMerge: true });
        yield* pr.service.sweep;
        assert.deepEqual(pr.state.branchCalls, ["topic"]);
        assert.equal(pr.state.directReads, 1);
        assert.equal(pr.state.tracks, 0);
        assert.equal((yield* f.thread()).settledBy, "auto");
      }),
    ),
);
it.effect("settles as soon as branch status sees the PR merge, without waiting for a sweep", () =>
  runWithBranch((f) =>
    Effect.gen(function* () {
      const pr = yield* prFixture(f, { branch: true, noLink: true });
      // Starting runs one sweep while merge settlement is still off; the clock never advances.
      yield* pr.service.start;
      const settledAfter = (yields: number) =>
        Effect.gen(function* () {
          for (let left = yields; left > 0; left--) {
            if ((yield* f.thread()).settledAt !== null) return true;
            yield* Effect.yieldNow;
          }
          return (yield* f.thread()).settledAt !== null;
        });
      assert.isFalse(yield* settledAfter(50));
      yield* f.settings.updateSettings({ autoSettleOnPullRequestMerge: true });
      assert.isFalse(yield* settledAfter(50));
      yield* Queue.offer(pr.statusChanges, "https://gitlab.example/team/repo/-/merge_requests/7");
      // Settling can wait on I/O, so a loaded runner needs real time rather than a count of yields.
      const deadline = Date.now() + 5_000;
      while ((yield* f.thread()).settledAt === null && Date.now() < deadline)
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)));
      assert.isNotNull((yield* f.thread()).settledAt);
      assert.equal((yield* f.thread()).settledBy, "auto");
    }),
  ),
);
it.effect(
  "a newer open PR on a reused branch keeps an older terminal linked PR's thread active",
  () =>
    runWithBranch((f) =>
      Effect.gen(function* () {
        const pr = yield* prFixture(f, { branch: true });
        pr.state.branchState = "open";
        yield* f.settings.updateSettings({ autoSettleOnPullRequestMerge: true });
        yield* pr.service.sweep;
        assert.equal(pr.state.reads, 1);
        assert.deepEqual(pr.state.branchCalls, ["topic"]);
        assert.isNull((yield* f.thread()).settledAt);
      }),
    ),
);
it.effect(
  "unknown branch identity, changed accounts and disabled policy after remote waits keep threads active",
  () =>
    runWithBranch((f) =>
      Effect.gen(function* () {
        const pr = yield* prFixture(f, { branch: true, noLink: true });
        yield* f.settings.updateSettings({ autoSettleOnPullRequestMerge: true });
        pr.state.branchState = "unknown";
        yield* pr.service.sweep;
        assert.isNull((yield* f.thread()).settledAt);
        assert.equal(pr.state.directReads, 0);
        pr.state.branchState = "merged";
        pr.state.changeAccount = true;
        yield* pr.service.sweep;
        assert.isNull((yield* f.thread()).settledAt);
        pr.state.generation = "gen-1";
        pr.state.changeAccount = false;
        pr.state.disableDuringRead = true;
        yield* pr.service.sweep;
        assert.isNull((yield* f.thread()).settledAt);
      }),
    ),
);
it.effect("does not reuse linked-PR cache entries as head-fenced branch proof", () =>
  runWithBranch((f) =>
    Effect.gen(function* () {
      const pr = yield* prFixture(f, { branch: true });
      pr.state.directHead = "changed-head";
      yield* f.settings.updateSettings({ autoSettleOnPullRequestMerge: true });
      yield* pr.service.sweep;
      assert.equal(pr.state.reads, 1);
      assert.equal(pr.state.directReads, 1);
      assert.isNull((yield* f.thread()).settledAt);
    }),
  ),
);
it.effect("honors repository exclusions before and after an unlinked PR read", () =>
  runWithBranch((f) =>
    Effect.gen(function* () {
      const pr = yield* prFixture(f, { branch: true, noLink: true });
      yield* f.settings.updateSettings({
        autoSettleOnPullRequestMerge: true,
        prHub: { excludeRepos: [" TEAM/REPO "] },
      });
      yield* pr.service.sweep;
      assert.equal(pr.state.directReads, 0);
      assert.isNull((yield* f.thread()).settledAt);
      yield* f.settings.updateSettings({ prHub: { excludeRepos: [] } });
      pr.state.excludeDuringRead = true;
      yield* pr.service.sweep;
      assert.equal(pr.state.directReads, 1);
      assert.isNull((yield* f.thread()).settledAt);
    }),
  ),
);
it.effect("shares branch and detail reads among threads with the same project branch", () =>
  runWithBranch((f) =>
    Effect.gen(function* () {
      const other = ThreadId.makeUnsafe("same-unlinked-branch");
      yield* f.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("create-same-unlinked"),
        threadId: other,
        projectId,
        title: "Same branch",
        model: "gpt-5.1-codex",
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: "topic",
        worktreePath: null,
        createdAt: old,
      });
      const pr = yield* prFixture(f, { branch: true, noLink: true });
      yield* f.settings.updateSettings({ autoSettleOnPullRequestMerge: true });
      yield* pr.service.sweep;
      assert.deepEqual(pr.state.branchCalls, ["topic"]);
      assert.equal(pr.state.directReads, 1);
      assert.equal(pr.state.tracks, 0);
      assert.isNotNull((yield* f.thread()).settledAt);
      assert.isNotNull(
        (yield* f.engine.getReadModel()).threads.find((t) => t.id === other)?.settledAt,
      );
    }),
  ),
);
it.effect("bounds branch lookups and rotates the next sweep so later threads are not starved", () =>
  runWithBranch((f) =>
    Effect.gen(function* () {
      for (let n = 0; n < 40; n++)
        yield* f.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(`budget-${n}`),
          threadId: ThreadId.makeUnsafe(`branch-budget-${n}`),
          projectId,
          title: "Budget",
          model: "gpt-5.1-codex",
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: `topic-${n}`,
          worktreePath: null,
          createdAt: old,
        });
      const pr = yield* prFixture(f, { branch: true, noLink: true });
      pr.state.branchState = "none";
      yield* f.settings.updateSettings({ autoSettleOnPullRequestMerge: true });
      yield* pr.service.sweep;
      assert.equal(pr.state.branchCalls.length, 32);
      assert.equal(pr.state.directReads, 0);
      const first = new Set(pr.state.branchCalls);
      yield* pr.service.sweep;
      assert.equal(pr.state.branchCalls.length, 64);
      assert.isTrue(pr.state.branchCalls.slice(32).some((branch) => !first.has(branch)));
    }),
  ),
);
