import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ThreadId,
  TurnId,
  type ClientThreadTurnStartCommand,
  type NextTurnQueueSnapshot,
  type ThreadTurnStartCommand,
} from "@t3tools/contracts";
import { Deferred, Effect, Fiber, Layer, FileSystem, Path, PubSub, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import { emptyQueue } from "../agentBridge/testing/fakeHost.ts";
import {
  makeTurnSubmissionService,
  type TurnSubmissionDependencies,
} from "../TurnSubmissionService.ts";
import { NextTurnQueueStoreLive } from "../nextTurnQueue/Layers/NextTurnQueueStore.ts";
import { NextTurnQueueStore } from "../nextTurnQueue/Services/NextTurnQueueStore.ts";
import { bindSubmissionTurnIds } from "../nextTurnQueue/submissionStatus.ts";
import { cancelQueuedSubmission } from "../nextTurnQueue/cancelSubmission.ts";
import { threadPurgeHandlers } from "../storage/threadPurgePolicy.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeProjectionTurnRepository } from "../persistence/Layers/ProjectionTurns.ts";
import { makePortReviewReactor, type PortReviewReactorDeps } from "./portReview.ts";
import type { UpstreamGitHub } from "./github.ts";
import type { OrchestrationEvent } from "@t3tools/contracts";
import { makeUpstreamStore } from "./store.ts";
import { FakeGitRepo, FakeHost, FakeGitHub } from "./testing/fakes.ts";
import {
  REVIEW_NOW,
  REVIEW_PR,
  REVIEW_SLOTS,
  reviewThread,
  reviewWorkflow,
} from "./testing/reviewFixtures.ts";

const layer = it.layer(
  NextTurnQueueStoreLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "f5-port-review-" })),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const queue = yield* NextTurnQueueStore;
  const turns = yield* makeProjectionTurnRepository;
  const store = makeUpstreamStore(sql);
  const fake = new FakeHost(new FakeGitRepo());
  const domainEvents = yield* PubSub.unbounded<OrchestrationEvent>();
  let receivedEvents = 0;
  const thread = reviewThread({
    id: ThreadId.makeUnsafe(crypto.randomUUID()),
    model: "claude-test",
    modelSelection: { instanceId: "claudeAgent" as never, model: "claude-test" },
  });
  yield* sql`INSERT OR IGNORE INTO projection_projects (project_id, title, workspace_root,
    default_model, scripts_json, created_at, updated_at, deleted_at)
    VALUES (${thread.projectId}, 'Project', '/tmp', NULL, '[]', ${REVIEW_NOW}, ${REVIEW_NOW}, NULL)`;
  yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model, branch,
    worktree_path, latest_turn_id, archived_at, created_at, last_interaction_at, updated_at, deleted_at)
    VALUES (${thread.id}, ${thread.projectId}, 'Port', 'claude-test', ${thread.branch},
      NULL, NULL, NULL, ${REVIEW_NOW}, ${REVIEW_NOW}, ${REVIEW_NOW}, NULL)`;
  fake.threads = [thread];
  const snapshot = (id = thread.id) =>
    queue.listByThread(id).pipe(
      Effect.map(
        (data): NextTurnQueueSnapshot => ({
          ...emptyQueue(id),
          items: data.items,
          revision: data.state.revision,
          paused: data.state.paused,
        }),
      ),
    );
  const dispatcher = {
    getSnapshot: snapshot,
    submitAndSettle: ({
      submissionId,
      itemId,
      threadId,
    }: {
      submissionId: CommandId;
      itemId: CommandId;
      threadId: ThreadId;
    }) =>
      snapshot(threadId).pipe(
        Effect.map((snapshot) => ({
          disposition: "queued" as const,
          submissionId,
          itemId,
          snapshot,
        })),
      ),
    notify: () => Effect.void,
  };
  const sources: string[] = [];
  const submit = makeTurnSubmissionService({
    nextTurnQueueStore: queue,
    awaitOrchestrationRuntimeForRoute: Effect.succeed({
      nextTurnQueueDispatcher: dispatcher,
      orchestrationEngine: { getReadModel: () => fake.host.readModel },
    }) as unknown as TurnSubmissionDependencies["awaitOrchestrationRuntimeForRoute"],
    git: {} as TurnSubmissionDependencies["git"],
    singleFlightBootstrap: (_id, _hash, effect) => effect,
    startWorktreeSetupSubmission: () => Effect.die("Unexpected bootstrap"),
    runBootstrapTurnStart: () => Effect.die("Unexpected bootstrap"),
    normalizeDispatchCommand: ({ command, submissionSource }) =>
      Effect.sync(() => {
        sources.push(submissionSource);
        return {
          ...command,
          message: { ...command.message, attachments: [] },
        } as ThreadTurnStartCommand;
      }),
    removePersistedTurnAttachments: () => Effect.void,
    releaseSentUploads: () => Effect.void,
  });
  const host = {
    ...fake.host,
    domainEvents: Stream.fromPubSub(domainEvents).pipe(
      Stream.tap(() =>
        Effect.sync(() => {
          receivedEvents++;
        }),
      ),
    ),
    getQueueSnapshot: snapshot,
    getSubmission: queue.getBySubmissionId,
    getTurnState: (input: Parameters<typeof turns.getByTurnId>[0]) =>
      turns
        .getByTurnId(input)
        .pipe(Effect.map((turn) => (turn._tag === "Some" ? turn.value.state : null))),
    getThreadDetails: (id: ThreadId) =>
      Effect.gen(function* () {
        const details = yield* fake.host.getThreadDetails(id);
        return bindSubmissionTurnIds(details, yield* turns.listByThreadId({ threadId: id }));
      }),
    submitTurn: (body: Parameters<typeof submit>[0], source: "human" | "automation") =>
      submit(body, { submissionSource: source }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, pathService),
      ),
    cancelQueuedSubmission: (id: CommandId) => cancelQueuedSubmission(queue, dispatcher.notify, id),
  };
  let currentTime = new Date(REVIEW_NOW);
  let report = "Fix the missing error handler.";
  let submitFails = false;
  let github: UpstreamGitHub | null = {
    ...new FakeGitHub().github,
    available: () => Effect.succeed(true),
    findPullRequest: () =>
      Effect.succeed({
        number: 42,
        url: REVIEW_PR,
        state: "open",
        headRepoFullName: "o/f5",
        headRef: thread.branch!,
        headSha: "abc",
      }),
  };
  let notifications = 0;
  const submittedCommands: string[] = [];
  const make = (overrides: Partial<PortReviewReactorDeps> = {}) =>
    makePortReviewReactor({
      host: {
        ...host,
        submitTurn: (body, source) =>
          Effect.suspend(() => {
            submittedCommands.push(JSON.stringify(body.command));
            return submitFails ? Effect.fail(new Error("offline")) : host.submitTurn(body, source);
          }),
      },
      store,
      github,
      context: () => Effect.succeed({ cwd: "/repo", ledgerDir: "upstream" }),
      originUrl: () => Effect.succeed("https://github.com/o/f5"),
      projectedPrUrl: () => Effect.succeed(null),
      emit: () =>
        Effect.sync(() => {
          notifications++;
        }),
      now: () => currentTime,
      mintId: () => crypto.randomUUID(),
      ...overrides,
    });
  const clientRequestId = crypto.randomUUID();
  const portCommand: ClientThreadTurnStartCommand = {
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe("port"),
    threadId: thread.id,
    message: {
      messageId: MessageId.makeUnsafe("port"),
      role: "user",
      text: "<upstream-data>Port settings</upstream-data>",
      attachments: [],
    },
    model: thread.model,
    interactionMode: "default",
    runtimeMode: thread.runtimeMode,
    createdAt: REVIEW_NOW,
  };
  yield* store.insertPortRequest({
    projectId: thread.projectId,
    clientRequestId,
    argsHash: "hash",
    at: REVIEW_NOW,
    groups: [
      {
        groupIndex: 0,
        threadId: thread.id,
        submissionId: "port",
        topicIds: ["pr-1"],
        command: portCommand,
      },
    ],
    links: [{ groupIndex: 0, threadId: thread.id, topicId: "pr-1", epoch: 2 }],
    reviews: [{ groupIndex: 0, threadId: thread.id, reviewers: REVIEW_SLOTS }],
  });
  const reactor = make();
  const finishReview = Effect.gen(function* () {
    yield* reactor.advance(thread.id);
    const row = (yield* store.getPortReviewByThread(thread.id))!;
    const workflow = { ...reviewWorkflow(true), id: row.reviewWorkflowId as never };
    fake.workflows = [workflow];
    fake.threads = [
      thread,
      reviewThread({ id: workflow.reviewerA.threadId }),
      reviewThread({ id: workflow.reviewerB.threadId }),
      reviewThread({
        id: workflow.consolidation.threadId!,
        messages: [
          {
            id: MessageId.makeUnsafe("report-message"),
            role: "assistant",
            text: report,
            turnId: TurnId.makeUnsafe("report-turn"),
            streaming: false,
            createdAt: REVIEW_NOW,
            updatedAt: REVIEW_NOW,
          },
        ],
      }),
    ];
  });
  return {
    sql,
    queue,
    turns,
    store,
    fake,
    thread,
    reactor,
    make,
    sources,
    submittedCommands,
    finishReview,
    failSubmit: (value: boolean) => {
      submitFails = value;
    },
    changeInputs: () => {
      currentTime = new Date("2026-10-23T00:00:00.000Z");
      report = "A changed report";
      fake.threads = fake.threads.map((entry) =>
        entry.id === thread.id ? { ...entry, model: "new-model" } : entry,
      );
    },
    setGitHub: (value: UpstreamGitHub) => {
      github = value;
    },
    notify: (event: OrchestrationEvent) => PubSub.publish(domainEvents, event),
    notifications: () => notifications,
    receivedEvents: () => receivedEvents,
  };
});

layer("port review persistence and queue", (it) => {
  it.effect("rejects a foreign PR locally even when GitHub is unavailable", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      h.setGitHub({ ...new FakeGitHub().github, available: () => Effect.succeed(false) });
      h.fake.threads[0] = {
        ...h.thread,
        messages: h.thread.messages.map((message) => ({
          ...message,
          text: "UPSTREAM-OUTCOME: pr https://github.com/foreign/repo/pull/1",
        })),
      };
      yield* h.make().advance(h.thread.id);
      assert.deepInclude((yield* h.store.getPortReviewByThread(h.thread.id))!, {
        status: "error",
        errorStage: "review-setup",
        detail: "Pull request URL does not belong to origin",
      });
      assert.lengthOf(h.fake.reviews, 0);
    }),
  );
  it.effect("does not claim cancellation if the submit never reached the queue", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      yield* h.finishReview;
      h.failSubmit(true);
      yield* h.reactor.advance(h.thread.id);
      h.fake.threads[0] = { ...h.thread, archivedAt: REVIEW_NOW };
      yield* h.reactor.advance(h.thread.id);
      assert.deepInclude((yield* h.store.getPortReviewByThread(h.thread.id))!, {
        status: "skipped",
        detail: "Port thread archived",
      });
    }),
  );
  it.effect("isolates corrupt intents while unrelated reviews advance", () =>
    Effect.gen(function* () {
      const bad = yield* setup;
      const good = yield* setup;
      bad.fake.threads = [bad.thread, good.thread];
      yield* bad.sql`UPDATE upstream_port_reviews SET reviewers_json = '{' WHERE port_thread_id = ${bad.thread.id}`;
      yield* bad.reactor.reconcile;
      assert.deepInclude((yield* bad.store.getPortReviewByThread(bad.thread.id))!, {
        status: "error",
        errorStage: "review-setup",
      });
      assert.strictEqual(
        (yield* good.store.getPortReviewByThread(good.thread.id))!.status,
        "reviewing",
      );
      yield* bad.sql`UPDATE upstream_port_reviews SET reviewers_json = ${JSON.stringify(REVIEW_SLOTS)},
        status = 'applying', apply_command_json = '{' WHERE port_thread_id = ${bad.thread.id}`;
      yield* bad.reactor.reconcile;
      assert.deepInclude((yield* bad.store.getPortReviewByThread(bad.thread.id))!, {
        status: "error",
        errorStage: "apply-feedback",
      });
    }),
  );
  it.effect("keeps routing rows admitted during an in-flight reconcile snapshot", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      const captured = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const reactor = h.make({
        store: {
          ...h.store,
          listActivePortReviews: Effect.gen(function* () {
            const rows = yield* h.store.listActivePortReviews;
            yield* Deferred.succeed(captured, undefined);
            yield* Deferred.await(release);
            return rows;
          }),
        },
      });
      const events = yield* reactor.subscribe;
      yield* events.pipe(Effect.forkScoped);
      const reconciliation = yield* reactor.reconcile.pipe(Effect.forkScoped);
      yield* Deferred.await(captured);
      const newer = yield* setup;
      h.fake.threads.push(newer.thread);
      yield* reactor.advance(newer.thread.id);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(reconciliation);
      yield* newer.finishReview;
      h.fake.workflows = newer.fake.workflows;
      h.fake.threads = [h.thread, ...newer.fake.threads];
      const workflow = h.fake.workflows[0]!;
      yield* h.notify({
        type: "project.code-review-workflow-upserted",
        aggregateId: h.thread.projectId,
        payload: { workflow },
      } as OrchestrationEvent);
      for (
        let i = 0;
        i < 100 && (yield* h.store.getPortReviewByThread(newer.thread.id))!.status !== "applying";
        i++
      )
        yield* Effect.yieldNow;
      assert.strictEqual(
        (yield* h.store.getPortReviewByThread(newer.thread.id))!.status,
        "applying",
      );
    }),
  );
  it.effect("retries a transient submit through the short retry queue", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      yield* h.finishReview;
      h.failSubmit(true);
      yield* h.reactor.advance(h.thread.id);
      h.failSubmit(false);
      yield* h.reactor.retryPending;
      assert.strictEqual((yield* h.store.getPortReviewByThread(h.thread.id))!.status, "applying");
      assert.strictEqual(h.submittedCommands[0], h.submittedCommands[1]);
    }),
  );
  it.effect("two retries after a failed revision and moved head retain the known PR", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      yield* h.finishReview;
      h.failSubmit(true);
      yield* h.reactor.advance(h.thread.id);
      yield* h.reactor.retryPending;
      yield* h.reactor.retryPending;
      h.fake.threads[0] = {
        ...h.thread,
        latestTurn: { ...h.thread.latestTurn!, state: "error" },
        messages: [],
      };
      h.setGitHub({
        ...new FakeGitHub().github,
        available: () => Effect.succeed(true),
        findPullRequest: () =>
          Effect.succeed({
            number: 42,
            url: REVIEW_PR,
            state: "open",
            headRepoFullName: "o/f5",
            headRef: h.thread.branch!,
            headSha: "new",
          }),
      });
      const reactor = h.make();
      yield* reactor.retry(h.thread.projectId, h.thread.id);
      assert.strictEqual((yield* h.store.getPortReviewByThread(h.thread.id))!.errorStage, "review");
      yield* reactor.retry(h.thread.projectId, h.thread.id);
      assert.deepInclude((yield* h.store.getPortReviewByThread(h.thread.id))!, {
        status: "reviewing",
        prUrl: REVIEW_PR,
        reviewedHeadSha: "new",
      });
      assert.lengthOf(h.fake.reviews, 2);
    }),
  );
  it.effect(
    "leaves an accepted failed delivery running on skip, and retry never duplicates it",
    () =>
      Effect.gen(function* () {
        const h = yield* setup;
        yield* h.finishReview;
        yield* h.reactor.advance(h.thread.id);
        const item = (yield* h.queue.listByThread(h.thread.id)).items[0]!;
        yield* h.queue.claim({
          itemId: item.itemId,
          leaseOwner: "delivery",
          now: REVIEW_NOW,
          leaseExpiresAt: "2026-10-23T00:00:00.000Z",
        });
        yield* h.queue.markFailed({
          itemId: item.itemId,
          leaseOwner: "delivery",
          errorCode: "dispatch_rejected",
          errorDetail: "provider delivery failed",
        });
        yield* h.sql`INSERT INTO orchestration_command_receipts
        (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, error)
        VALUES (${item.command.commandId}, 'thread', ${h.thread.id}, ${REVIEW_NOW}, 9, 'accepted', NULL)`;
        const ambiguous = (yield* h.store.getPortReviewByThread(h.thread.id))!;
        yield* h.store.updatePortReview({
          ...ambiguous,
          status: "error",
          errorStage: "apply-feedback",
          detail: "Submission result lost",
        });
        yield* h.reactor.retry(h.thread.projectId, h.thread.id);
        assert.strictEqual((yield* h.store.getPortReviewByThread(h.thread.id))!.status, "applying");
        assert.lengthOf(h.submittedCommands, 1);
        h.fake.threads[0] = { ...h.thread, archivedAt: REVIEW_NOW };
        yield* h.reactor.advance(h.thread.id);
        assert.deepInclude((yield* h.store.getPortReviewByThread(h.thread.id))!, {
          status: "skipped",
          detail: "Port thread archived; the revision had already started and was left running",
        });
        h.fake.threads[0] = h.thread;
        yield* h.reactor.retry(h.thread.projectId, h.thread.id);
        assert.strictEqual((yield* h.store.getPortReviewByThread(h.thread.id))!.status, "applying");
        assert.lengthOf(h.submittedCommands, 1);
        assert.lengthOf((yield* h.queue.listByThread(h.thread.id)).items, 1);
        yield* h.queue.complete({ itemId: item.itemId, sequence: 10 });
        const turnId = TurnId.makeUnsafe("accepted-revision");
        yield* h.turns.upsertByTurnId({
          threadId: h.thread.id,
          turnId,
          pendingMessageId: item.command.message.messageId,
          assistantMessageId: null,
          state: "completed",
          requestedAt: REVIEW_NOW,
          startedAt: REVIEW_NOW,
          completedAt: REVIEW_NOW,
          processingQuiescedAt: REVIEW_NOW,
          checkpointTurnCount: null,
          checkpointRef: null,
          checkpointStatus: null,
          checkpointFiles: [],
        });
        const row = (yield* h.store.getPortReviewByThread(h.thread.id))!;
        yield* h.store.updatePortReview({ ...row, status: "skipped", applyTurnId: turnId });
        yield* h.reactor.retry(h.thread.projectId, h.thread.id);
        assert.strictEqual(
          (yield* h.store.getPortReviewByThread(h.thread.id))!.status,
          "completed",
        );
        assert.lengthOf(h.submittedCommands, 1);
      }),
  );
  it.effect("fresh retry picks up a replacement PR after the old PR closes", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      yield* h.finishReview;
      const row = (yield* h.store.getPortReviewByThread(h.thread.id))!;
      yield* h.store.updatePortReview({
        ...row,
        status: "skipped",
        prUrl: REVIEW_PR,
        reviewedHeadSha: "old",
        detail: "Pull request is closed",
      });
      h.fake.threads[0] = {
        ...h.thread,
        messages: h.thread.messages.map((message) => ({
          ...message,
          text: "UPSTREAM-OUTCOME: pr https://github.com/o/f5/pull/43",
        })),
      };
      yield* h.reactor.retry(h.thread.projectId, h.thread.id);
      const retried = (yield* h.store.getPortReviewByThread(h.thread.id))!;
      assert.strictEqual(retried.prUrl, "https://github.com/o/f5/pull/43");
      assert.strictEqual(retried.status, "reviewing");
      assert.strictEqual(retried.reviewedHeadSha, "abc");
    }),
  );
  it.effect("purges review payloads with their port thread", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      yield* h.finishReview;
      yield* h.reactor.advance(h.thread.id);
      assert.isNotNull((yield* h.store.getPortReviewByThread(h.thread.id))?.applyCommandJson);
      yield* threadPurgeHandlers.upstream_port_reviews(h.sql, h.thread.id);
      assert.isNull(yield* h.store.getPortReviewByThread(h.thread.id));
      yield* h.reactor.reconcile;
    }),
  );
  it.effect("handles workflow and archive events while reconciliation is active", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      const events = yield* h.reactor.subscribe;
      yield* events.pipe(Effect.forkScoped);
      yield* h.finishReview;
      const workflow = h.fake.workflows[0]!;
      yield* h.notify({
        type: "project.code-review-workflow-upserted",
        aggregateId: h.thread.projectId,
        payload: { projectId: h.thread.projectId, workflow },
      } as unknown as OrchestrationEvent);
      for (
        let count = 0;
        count < 100 && (yield* h.store.getPortReviewByThread(h.thread.id))?.status !== "applying";
        count++
      )
        yield* Effect.yieldNow;
      assert.strictEqual(h.receivedEvents(), 1);
      assert.strictEqual((yield* h.store.getPortReviewByThread(h.thread.id))?.status, "applying");
      h.fake.threads[0] = { ...h.thread, archivedAt: REVIEW_NOW };
      yield* h.notify({
        type: "thread.archived",
        aggregateId: h.thread.id,
        payload: { threadId: h.thread.id },
      } as unknown as OrchestrationEvent);
      for (
        let count = 0;
        count < 100 && (yield* h.store.getPortReviewByThread(h.thread.id))?.status !== "skipped";
        count++
      )
        yield* Effect.yieldNow;
      assert.deepInclude((yield* h.store.getPortReviewByThread(h.thread.id))!, {
        status: "skipped",
        detail: "Port thread archived; queued revision canceled",
      });
    }),
  );
  it.effect("retries a blocked first outcome after a later turn produces a PR", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      h.fake.threads[0] = {
        ...h.thread,
        messages: h.thread.messages.map((m) => ({
          ...m,
          text: "UPSTREAM-OUTCOME: blocked missing dependency",
        })),
      };
      yield* h.reactor.advance(h.thread.id);
      assert.strictEqual((yield* h.store.getPortReviewByThread(h.thread.id))!.status, "skipped");
      h.fake.threads[0] = h.thread;
      yield* h.reactor.retry(h.thread.projectId, h.thread.id);
      assert.lengthOf(h.fake.reviews, 1);
      assert.strictEqual((yield* h.store.getPortReviewByThread(h.thread.id))!.status, "reviewing");
    }),
  );
  it.effect(
    "recovers a prompt budget failure after compaction, without another review workflow",
    () =>
      Effect.gen(function* () {
        const h = yield* setup;
        yield* h.finishReview;
        h.fake.threads[0] = { ...h.thread, estimatedContextTokens: 10_000_000 };
        yield* h.reactor.advance(h.thread.id);
        assert.deepInclude((yield* h.store.getPortReviewByThread(h.thread.id))!, {
          status: "error",
          errorStage: "apply-feedback",
        });
        h.fake.threads[0] = { ...h.thread, estimatedContextTokens: 0 };
        yield* h.reactor.retry(h.thread.projectId, h.thread.id);
        assert.strictEqual((yield* h.store.getPortReviewByThread(h.thread.id))!.status, "applying");
        assert.lengthOf(h.fake.reviews, 1);
        assert.lengthOf(h.submittedCommands, 1);
      }),
  );
  it.effect("ends three unsettled submit failures in a retryable error", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      yield* h.finishReview;
      h.failSubmit(true);
      yield* Effect.all(
        Array.from({ length: 3 }, () => h.reactor.advance(h.thread.id)),
        { concurrency: "unbounded" },
      );
      const row = (yield* h.store.getPortReviewByThread(h.thread.id))!;
      assert.deepInclude(row, { status: "error", errorStage: "apply-feedback", submitFailures: 3 });
      assert.strictEqual(new Set(h.submittedCommands).size, 1);
      h.failSubmit(false);
      yield* h.reactor.retry(h.thread.projectId, h.thread.id);
      assert.strictEqual((yield* h.store.getPortReviewByThread(h.thread.id))!.status, "applying");
      assert.notStrictEqual(h.submittedCommands[3], h.submittedCommands[0]);
      assert.lengthOf(h.fake.reviews, 1);
    }),
  );
  it.effect("re-reviews a changed PR head on retry", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      yield* h.finishReview;
      const row = (yield* h.store.getPortReviewByThread(h.thread.id))!;
      yield* h.store.updatePortReview({ ...row, reviewedHeadSha: "abc" });
      h.setGitHub({
        ...new FakeGitHub().github,
        available: () => Effect.succeed(true),
        findPullRequest: () =>
          Effect.succeed({
            number: 42,
            url: REVIEW_PR,
            state: "open",
            headRepoFullName: "o/f5",
            headRef: h.thread.branch!,
            headSha: "def",
          }),
      });
      const reactor = h.make();
      yield* reactor.advance(h.thread.id);
      assert.deepInclude((yield* h.store.getPortReviewByThread(h.thread.id))!, {
        status: "error",
        errorStage: "review",
      });
      yield* reactor.retry(h.thread.projectId, h.thread.id);
      assert.lengthOf(h.fake.reviews, 2);
      assert.strictEqual(
        (yield* h.store.getPortReviewByThread(h.thread.id))!.reviewedHeadSha,
        "def",
      );
      assert.notStrictEqual(h.fake.reviews[0]!.workflowId, h.fake.reviews[1]!.workflowId);
    }),
  );
  it.effect("archive then restore and retry resumes from a completed report", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      yield* h.finishReview;
      h.fake.threads[0] = { ...h.thread, archivedAt: REVIEW_NOW };
      yield* h.reactor.advance(h.thread.id);
      assert.strictEqual((yield* h.store.getPortReviewByThread(h.thread.id))!.status, "skipped");
      h.fake.threads[0] = h.thread;
      h.fake.workflows[0] = { ...h.fake.workflows[0]!, archivedAt: REVIEW_NOW };
      yield* h.reactor.retry(h.thread.projectId, h.thread.id);
      assert.strictEqual((yield* h.store.getPortReviewByThread(h.thread.id))!.status, "applying");
      assert.lengthOf(h.fake.reviews, 1);
    }),
  );
  it.effect("notifies on derived workflow errors without persisting a transition", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      yield* h.finishReview;
      const workflow = h.fake.workflows[0]!;
      h.fake.workflows[0] = {
        ...workflow,
        consolidation: { ...workflow.consolidation, status: "error", error: "Failed" },
      };
      const before = h.notifications();
      yield* h.reactor.advance(h.thread.id);
      assert.strictEqual((yield* h.store.getPortReviewByThread(h.thread.id))!.status, "reviewing");
      assert.isAbove(h.notifications(), before);
      const after = h.notifications();
      yield* h.reactor.advance(h.thread.id);
      assert.strictEqual(h.notifications(), after);
    }),
  );
  it.effect(
    "queues behind a running turn, resolves a null-turnId send, and stays completed after later user work",
    () =>
      Effect.gen(function* () {
        const h = yield* setup;
        yield* h.finishReview;
        assert.lengthOf(h.fake.reviews, 1);
        h.fake.threads[0] = {
          ...h.fake.threads[0]!,
          latestTurn: { ...h.thread.latestTurn!, state: "running" },
        };
        yield* h.reactor.advance(h.thread.id);
        const applying = (yield* h.store.getPortReviewByThread(h.thread.id))!;
        assert.strictEqual(applying.status, "applying");
        assert.deepStrictEqual(h.sources, ["automation"]);
        const item = (yield* h.queue.listByThread(h.thread.id)).items[0]!;
        const command = item.command;
        assert.strictEqual(command.runtimeMode, "approval-required");
        yield* h.queue.complete({ itemId: item.itemId, sequence: 10 });
        const turnId = TurnId.makeUnsafe("revision-turn");
        h.fake.threads[0] = {
          ...h.fake.threads[0]!,
          messages: [
            ...h.thread.messages,
            {
              id: command.message.messageId,
              role: "user",
              text: command.message.text,
              turnId: null,
              streaming: false,
              createdAt: REVIEW_NOW,
              updatedAt: REVIEW_NOW,
            },
          ],
          latestTurn: {
            ...h.thread.latestTurn!,
            turnId: TurnId.makeUnsafe("later-user-turn"),
            state: "running",
          },
        };
        yield* h.turns.upsertByTurnId({
          threadId: h.thread.id,
          turnId,
          pendingMessageId: command.message.messageId,
          assistantMessageId: null,
          state: "completed",
          requestedAt: REVIEW_NOW,
          startedAt: REVIEW_NOW,
          completedAt: REVIEW_NOW,
          processingQuiescedAt: REVIEW_NOW,
          checkpointTurnCount: null,
          checkpointRef: null,
          checkpointStatus: null,
          checkpointFiles: [],
        });
        assert.isNull(h.fake.threads[0]!.messages.at(-1)!.turnId);
        h.fake.threads[0] = {
          ...h.fake.threads[0]!,
          messages: [
            ...h.fake.threads[0]!.messages,
            {
              ...h.thread.messages[0]!,
              id: MessageId.makeUnsafe("revision-outcome"),
              turnId,
              text: "UPSTREAM-OUTCOME: blocked tests failed",
            },
          ],
        };
        yield* h.reactor.advance(h.thread.id);
        assert.strictEqual(
          (yield* h.store.getPortReviewByThread(h.thread.id))!.status,
          "completed",
        );
        assert.include(
          (yield* h.store.getPortReviewByThread(h.thread.id))!.detail!,
          "Revision blocked: tests failed",
        );
        yield* h.make().reconcile;
        assert.strictEqual(
          (yield* h.store.getPortReviewByThread(h.thread.id))!.status,
          "completed",
        );
      }),
  );
  it.effect("resubmits persisted intent byte-for-byte after a failure and restart", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      yield* h.finishReview;
      h.failSubmit(true);
      yield* h.reactor.advance(h.thread.id);
      const pending = (yield* h.store.getPortReviewByThread(h.thread.id))!;
      assert.strictEqual(pending.status, "apply_pending");
      h.changeInputs();
      h.failSubmit(false);
      yield* h.make().advance(h.thread.id);
      assert.strictEqual(h.submittedCommands[0], h.submittedCommands[1]);
      assert.strictEqual(h.submittedCommands[1], pending.applyCommandJson);
      assert.lengthOf(h.fake.reviews, 1);
    }),
  );
  it.effect("reports a revision removed through the real queue's softDelete as an error", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      yield* h.finishReview;
      yield* h.reactor.advance(h.thread.id);
      const item = (yield* h.queue.listByThread(h.thread.id)).items[0]!;
      yield* h.queue.softDelete({ itemId: item.itemId });
      yield* h.reactor.advance(h.thread.id);
      assert.deepInclude((yield* h.store.getPortReviewByThread(h.thread.id))!, {
        status: "error",
        errorStage: "apply-feedback",
        detail: "Revision was removed from the queue",
      });
    }),
  );
  it.effect("cancels a queued revision promptly when the port is unlinked", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      yield* h.finishReview;
      yield* h.reactor.advance(h.thread.id);
      yield* h.store.setLinkState(
        { projectId: h.thread.projectId, threadId: h.thread.id, topicId: "pr-1" },
        "unlinked",
      );
      yield* h.reactor.advance(h.thread.id);
      assert.lengthOf((yield* h.queue.listByThread(h.thread.id)).items, 0);
      assert.deepInclude((yield* h.store.getPortReviewByThread(h.thread.id))!, {
        status: "skipped",
        detail: "Port unlinked; queued revision canceled",
      });
    }),
  );
});
