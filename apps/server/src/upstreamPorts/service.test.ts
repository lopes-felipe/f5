import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  BOOTSTRAP_THREAD_NOT_CREATED_ERROR_CODE,
  UPSTREAM_LEDGER_SCHEMA_VERSION,
  type UpstreamTopic,
  type UpstreamTriageBatchResult,
} from "@t3tools/contracts";
import {
  digestShas,
  serializeLedgerFiles,
  sha256Hex,
  type UpstreamLedger,
} from "@t3tools/shared/upstreamPorts";
import { Deferred, Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { TextGenerationError } from "../git/Errors.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { UpstreamGitHubError } from "./github.ts";
import { makeUpstreamPortsService, type UpstreamPortsDeps } from "./service.ts";
import { makeUpstreamStore } from "./store.ts";
import {
  FakeGitHub,
  FakeGitRepo,
  FakeHost,
  PROJECT_ID,
  UPSTREAM_REPOSITORY,
} from "./testing/fakes.ts";

const layer = it.layer(SqlitePersistenceMemory.pipe(Layer.provideMerge(NodeServices.layer)));

const RULES = readFileSync(new URL("../../../../upstream/rules.json", import.meta.url), "utf8");

interface Fixture {
  readonly repo: FakeGitRepo;
  readonly gh: FakeGitHub;
  readonly host: FakeHost;
  readonly clock: { now: Date };
  readonly upstream: ReadonlyArray<string>;
  readonly target0: string;
  readonly baseDir: string;
  readonly make: (
    writer?: UpstreamPortsDeps["writer"],
    limits?: UpstreamPortsDeps["runLimits"],
  ) => ReturnType<typeof makeUpstreamPortsService>;
}

/** origin/main holds interval 1 (one topic, `pr-1`, in the inbox); upstream has `count` new commits. */
const setup = (
  options: {
    readonly count?: number;
    readonly paths?: (index: number) => ReadonlyArray<string>;
  } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM upstream_ledger_ops`;
    yield* sql`DELETE FROM upstream_ledger_publication`;
    yield* sql`DELETE FROM upstream_port_runs`;
    yield* sql`DELETE FROM upstream_port_occurrences`;
    yield* sql`DELETE FROM upstream_port_requests`;
    yield* sql`DELETE FROM upstream_port_groups`;
    yield* sql`DELETE FROM upstream_port_links`;
    yield* sql`DELETE FROM upstream_port_queue`;
    yield* sql`DELETE FROM upstream_port_queue_state`;
    yield* sql`DELETE FROM upstream_port_queue_requests`;
    yield* sql`DELETE FROM upstream_port_outcome_checks`;
    yield* sql`DELETE FROM next_turn_queue`;
    yield* sql`DELETE FROM projection_pending_approvals`;
    yield* sql`DELETE FROM projection_thread_messages`;
    const repo = new FakeGitRepo();
    repo.remotes.set("upstream", UPSTREAM_REPOSITORY);
    repo.remotes.set("origin", "https://github.com/o/f5.git");
    const root = repo.commit({ parent: null, subject: "Root", paths: ["README.md"] });
    const target0 = repo.commit({
      parent: root,
      subject: "Initial settings (#1)",
      paths: ["apps/web/settings.tsx"],
    });
    const topic0: UpstreamTopic = {
      id: "pr-1",
      createdAt: "2026-10-01T00:00:00.000Z",
      title: "Initial settings",
      summary: "",
      upstreamPrs: [1],
      status: "inbox",
      epoch: 1,
    };
    const ledger: UpstreamLedger = {
      intervals: [
        {
          schemaVersion: UPSTREAM_LEDGER_SCHEMA_VERSION,
          interval: 1,
          baseSha: root,
          targetSha: target0,
          selection: "first-parent",
          createdAt: "2026-10-01T00:00:00.000Z",
          count: 1,
          digest: digestShas([target0]),
          commits: [{ sha: target0, subject: "Initial settings (#1)", pr: 1, topic: "pr-1" }],
        },
      ],
      legacy: [],
      topics: [topic0],
    };
    const files = new Map<string, string>([
      ["upstream/rules.json", RULES],
      ["upstream/policy.md", "# Policy\nPort desktop features.\n"],
      ["apps/web/settings.tsx", "export {}\n"],
    ]);
    for (const [file, text] of serializeLedgerFiles(ledger)) files.set(`upstream/${file}`, text);
    const main = repo.commit({ parent: null, subject: "f5 main", files });
    repo.refs.set("refs/remotes/origin/main", main);
    const upstream: string[] = [];
    let parent = target0;
    for (let index = 0; index < (options.count ?? 3); index += 1) {
      parent = repo.commit({
        parent,
        subject: `Upstream change ${index} (#${index + 10})`,
        paths: options.paths?.(index) ?? [`apps/server/feature${index}.ts`],
      });
      upstream.push(parent);
    }
    repo.refs.set("refs/remotes/upstream/main", parent);
    const gh = new FakeGitHub();
    const host = new FakeHost(repo);
    const clock = { now: new Date("2026-10-22T12:00:00.000Z") };
    const baseDir = mkdtempSync(path.join(tmpdir(), "f5-upstream-base-"));
    let id = 0;
    const make: Fixture["make"] = (
      writer = { profileId: "p1", stateDir: "/state/p1", hostname: "host" },
      limits,
    ) =>
      makeUpstreamPortsService({
        host: host.host,
        store: makeUpstreamStore(sql),
        sql,
        git: repo.git,
        github: gh.github,
        baseDir,
        writer,
        now: () => clock.now,
        mintId: () => `id-${(id += 1)}`,
        ...(limits ? { runLimits: limits } : {}),
      });
    return { repo, gh, host, clock, upstream, target0, baseDir, make } satisfies Fixture;
  });

const triageAll =
  (decide: (sha: string) => Partial<UpstreamTriageBatchResult["groups"][number]>) =>
  (prompt: string): Effect.Effect<UpstreamTriageBatchResult> => {
    const shas = [...prompt.matchAll(/^commit ([0-9a-f]{40})$/gmu)].map((match) => match[1]!);
    return Effect.succeed({
      groups: shas.map((sha) => ({
        key: `k-${sha.slice(0, 8)}`,
        commits: [sha],
        attachTo: null,
        relatedTo: null,
        title: `Title ${sha.slice(0, 8)}`,
        summary: "",
        suggestion: "port" as const,
        reasonKey: null,
        reason: "Useful",
        userImpact: "medium" as const,
        confidence: 0.6,
        areas: [],
        question: null,
        ...decide(sha),
      })),
    });
  };

const prepareQueue = (
  count: number,
  concurrency = 2,
  paths?: (index: number) => ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const fixture = yield* setup({ count, ...(paths ? { paths } : {}) });
    fixture.host.settings = {
      ...fixture.host.settings,
      upstreamPorts: { ...fixture.host.settings.upstreamPorts, portConcurrency: concurrency },
    };
    fixture.host.triage = triageAll(() => ({ areas: ["server"] }));
    const service = yield* fixture.make();
    yield* service.run({ projectId: PROJECT_ID, kind: "upstream", triage: "llm" });
    yield* service.testing.awaitIdle;
    const ids = (yield* service.listTopicIds({
      projectId: PROJECT_ID,
      list: "inbox",
    })).topicIds.filter((id) => id !== "pr-1");
    for (let offset = 0; offset < ids.length; offset += 200)
      yield* service.decide({
        projectId: PROJECT_ID,
        topicIds: ids.slice(offset, offset + 200),
        decision: { kind: "port" },
      });
    return { fixture, service, ids };
  });
const queueInput = (ids: ReadonlyArray<string>, requestId: string, batchSize = 5) => ({
  projectId: PROJECT_ID,
  target: { kind: "ids" as const, topicIds: ids },
  grouping: "batched" as const,
  batchSize,
  modelSelection: { instanceId: "claudeAgent", model: "claude-test" } as never,
  runtimeMode: "full-access" as const,
  clientRequestId: requestId,
});
const completedThread = (id: string, turnId: string, messageId: string, state = "completed") =>
  ({
    id,
    title: "Port",
    deletedAt: null,
    archivedAt: null,
    branch: "port",
    pendingUserInputs: [],
    session: null,
    latestTurn: {
      turnId,
      state,
      requestedAt: "2026-10-22T12:00:00.000Z",
      startedAt: "2026-10-22T12:00:00.000Z",
      completedAt: "2026-10-22T12:01:00.000Z",
      processingQuiescedAt: "2026-10-22T12:01:00.000Z",
      assistantMessageId: messageId,
    },
  }) as never;

layer("upstream port queue", (it) => {
  it.effect("releases overlapping files after recording a settled not-applicable outcome", () =>
    Effect.gen(function* () {
      const { fixture, service, ids } = yield* prepareQueue(2, 1, () => ["shared.ts"]);
      yield* service.enqueuePort({
        ...queueInput(ids, "not-applicable-refill"),
        grouping: "separately",
      });
      yield* service.testing.awaitIdle;
      const first = (yield* service.getPortQueue({ projectId: PROJECT_ID })).entries[0]!;
      fixture.host.threads = [
        completedThread(first.threadId!, "not-applicable-turn", "not-applicable-message"),
      ];
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at)
        VALUES ('not-applicable-message',${first.threadId},'assistant','UPSTREAM-OUTCOME: not-applicable This feature is absent from f5.',0,'now','now')`;
      yield* service.testing.dispatchQueue(PROJECT_ID);
      const progress = yield* service.getPortQueue({ projectId: PROJECT_ID });
      assert.equal(progress.counts.recorded, 1);
      assert.equal(progress.counts.executing, 1);
      assert.equal(fixture.host.submissions.length, 2);
      assert.equal(
        (yield* service.getTopic({ projectId: PROJECT_ID, topicId: ids[0]! })).row.state,
        "skipped",
      );
    }),
  );

  for (const freshEvidence of [false, true])
    it.effect(
      `preserves a distant usage deadline with aging evidence; fresh recovery ${freshEvidence}`,
      () =>
        Effect.gen(function* () {
          const { fixture, service, ids } = yield* prepareQueue(1, 1);
          fixture.host.settings = { ...fixture.host.settings, autoResumeUsageLimitedThreads: true };
          let fetchedAt = "2026-10-22T12:00:00.000Z";
          let utilization = 100;
          Object.assign(fixture.host.host, {
            usageAccounts: Effect.sync(
              () =>
                [
                  {
                    providerInstanceId: "claudeAgent",
                    sections: [
                      {
                        kind: "claude-usage",
                        outcome: "available",
                        snapshot: {
                          fetchedAt,
                          data: {
                            subscriptionLabel: null,
                            limitsAvailable: true,
                            extraUsage: null,
                            windows: [
                              {
                                key: "five_hour",
                                label: "Five hours",
                                utilization,
                                resetsAt: "2026-10-22T15:00:00.000Z",
                              },
                            ],
                          },
                        },
                      },
                    ],
                  },
                ] as never,
            ),
          });
          yield* service.enqueuePort(queueInput(ids, "distant-usage-reset"));
          yield* service.testing.awaitIdle;
          fixture.clock.now = new Date("2026-10-22T12:06:00.000Z");
          yield* service.testing.dispatchQueue(PROJECT_ID);
          assert.equal(fixture.host.submissions.length, 0);
          assert.equal(
            (yield* service.getOverview(PROJECT_ID)).portQueue.hold?.retryAt,
            "2026-10-22T15:01:00.000Z",
          );
          if (freshEvidence) {
            fetchedAt = fixture.clock.now.toISOString();
            utilization = 10;
          } else fixture.clock.now = new Date("2026-10-22T15:02:00.000Z");
          yield* service.testing.dispatchQueue(PROJECT_ID);
          assert.equal(fixture.host.submissions.length, 1);
        }),
    );

  it.effect("shows disabled automatic usage recovery as requiring manual Resume", () =>
    Effect.gen(function* () {
      const { fixture, service, ids } = yield* prepareQueue(1, 1);
      fixture.host.settings = { ...fixture.host.settings, autoResumeUsageLimitedThreads: false };
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO upstream_port_queue_state(project_id,hold_kind,hold_message,hold_until)
        VALUES (${PROJECT_ID},'usage','Waiting','2026-10-22T15:00:00.000Z')`;
      yield* service.enqueuePort(queueInput(ids, "manual-usage-recovery"));
      yield* service.testing.awaitIdle;
      const summary = (yield* service.getOverview(PROJECT_ID)).portQueue;
      assert.equal(summary.hold?.retryAt, null);
      assert.match(summary.hold?.message ?? "", /Resume/);
      assert.equal(fixture.host.submissions.length, 0);
      yield* service.controlPortQueue({ projectId: PROJECT_ID, action: "resume" });
      yield* service.testing.awaitIdle;
      assert.equal(fixture.host.submissions.length, 1);
    }),
  );

  it.effect("rejects together enqueue over twenty topics as invalid", () =>
    Effect.gen(function* () {
      const { service, ids } = yield* prepareQueue(21);
      const result = yield* service
        .enqueuePort({
          ...queueInput(ids, "oversized-together"),
          grouping: "together",
        })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure.code, "invalid");
    }),
  );

  it.effect("an uncertain manual submission owns one slot without holding the whole queue", () =>
    Effect.gen(function* () {
      const { fixture, service, ids } = yield* prepareQueue(2, 2);
      const started = fixture.host.submitOutcome;
      let manualSubmission: string | undefined;
      fixture.host.submitOutcome = (body) => {
        manualSubmission ??= body.submissionId;
        return body.submissionId === manualSubmission ? Effect.succeed(null) : started(body);
      };
      yield* service.startPort({
        projectId: PROJECT_ID,
        topicIds: [ids[0]!],
        grouping: "together",
        modelSelection: queueInput(ids, "unused").modelSelection,
        runtimeMode: "full-access",
        clientRequestId: "manual-pending",
      });
      yield* service.enqueuePort(queueInput([ids[1]!], "beside-manual-pending"));
      yield* service.testing.awaitIdle;
      assert.equal((yield* service.getPortQueue({ projectId: PROJECT_ID })).counts.executing, 1);
      const overview = yield* service.getOverview(PROJECT_ID);
      assert.equal(overview.portQueue.running, 2);
      assert.equal(overview.portQueue.hold, null);
    }),
  );

  it.effect("briefly caches missing commit file evidence between queue wakes", () =>
    Effect.gen(function* () {
      const { fixture, service, ids } = yield* prepareQueue(1);
      yield* service.controlPortQueue({ projectId: PROJECT_ID, action: "pause" });
      let calls = 0;
      const original = fixture.repo.git.streamNumstat;
      Object.assign(fixture.repo.git, {
        streamNumstat: (...args: Parameters<typeof original>) => {
          calls++;
          return original(...args).pipe(Effect.map(() => new Map()));
        },
      });
      const input = queueInput(ids, "unknown-files");
      yield* service.enqueuePort(input);
      yield* service.testing.awaitIdle;
      const before = calls;
      for (let index = 0; index < 3; index++) {
        const preview = yield* service.previewPortGroups(input);
        assert.equal(preview.filesUnknown, 1);
        yield* service.testing.dispatchQueue(PROJECT_ID);
      }
      assert.equal(calls, before);
      fixture.clock.now = new Date("2026-10-22T12:00:31.000Z");
      yield* service.previewPortGroups(input);
      assert.equal(calls, before + 1);
    }),
  );

  it.effect("keeps the main overview available when the queue read model fails", () =>
    Effect.gen(function* () {
      const { fixture, service, ids } = yield* prepareQueue(1);
      yield* service.controlPortQueue({ projectId: PROJECT_ID, action: "pause" });
      yield* service.enqueuePort(queueInput(ids, "summary-read-failure"));
      yield* service.testing.awaitIdle;
      const read = fixture.host.host.readModel;
      let calls = 0;
      Object.assign(fixture.host.host, {
        readModel: Effect.suspend(() =>
          ++calls === 1 ? read : Effect.fail(new Error("Read model unavailable")),
        ),
      });
      const overview = yield* service.getOverview(PROJECT_ID);
      assert.equal(overview.counts.ready, 1);
    }),
  );

  it.effect("classifies a decision during branch construction as omitted", () =>
    Effect.gen(function* () {
      const { fixture, service, ids } = yield* prepareQueue(1, 1);
      Object.assign(fixture.host.host, {
        resolveAvailableBranchName: (_cwd: string, branch: string) =>
          service
            .decide({
              projectId: PROJECT_ID,
              topicIds: ids,
              decision: { kind: "skip", reasonKey: "maintenance" },
            })
            .pipe(Effect.as(branch)),
      });
      yield* service.enqueuePort(queueInput(ids, "decision-during-build"));
      yield* service.testing.awaitIdle;
      yield* service.testing.dispatchQueue(PROJECT_ID);
      const progress = yield* service.getPortQueue({ projectId: PROJECT_ID });
      assert.equal(progress.counts.omitted, 1);
      assert.equal(progress.counts.needsAttention, 0);
      assert.equal(fixture.host.submissions.length, 0);
    }),
  );

  it.effect("lists topics and details when the optional outcome message query fails", () =>
    Effect.gen(function* () {
      const { fixture, service, ids } = yield* prepareQueue(1, 1);
      yield* service.enqueuePort(queueInput(ids, "outcome-read-failure"));
      yield* service.testing.awaitIdle;
      const first = (yield* service.getPortQueue({ projectId: PROJECT_ID })).entries[0]!;
      fixture.host.threads = [
        completedThread(first.threadId!, "read-failure-turn", "read-failure-message"),
      ];
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE projection_thread_messages RENAME TO saved_upstream_test_messages`;
      yield* Effect.gen(function* () {
        const page = yield* service.listTopics({ projectId: PROJECT_ID, list: "in-progress" });
        assert.equal(page.topics.length, 1);
        assert.equal(page.topics[0]!.links[0]!.outcome, null);
        const detail = yield* service.getTopic({ projectId: PROJECT_ID, topicId: ids[0]! });
        assert.equal(detail.row.topic.id, ids[0]);
      }).pipe(
        Effect.ensuring(
          sql`ALTER TABLE saved_upstream_test_messages RENAME TO projection_thread_messages`.pipe(
            Effect.orDie,
          ),
        ),
      );
    }),
  );

  it.effect("does not dispatch from a non-writer profile", () =>
    Effect.gen(function* () {
      const { fixture, service, ids } = yield* prepareQueue(1, 1);
      yield* service.controlPortQueue({ projectId: PROJECT_ID, action: "pause" });
      yield* service.enqueuePort(queueInput(ids, "non-writer"));
      yield* service.testing.awaitIdle;
      const other = yield* fixture.make({
        profileId: "p2",
        stateDir: "/state/p2",
        hostname: "host",
      });
      yield* other.testing.dispatchQueue(PROJECT_ID);
      assert.equal(fixture.host.submissions.length, 0);
      assert.equal((yield* other.getOverview(PROJECT_ID)).portQueue.hold?.kind, "writer");
    }),
  );

  it.effect(
    "startup reconciliation skips deleted projects and still recovers the next project",
    () =>
      Effect.gen(function* () {
        const { fixture, service, ids } = yield* prepareQueue(1, 1);
        fixture.host.submitOutcome = () => Effect.succeed(null);
        yield* service.startPort({
          projectId: PROJECT_ID,
          topicIds: ids,
          grouping: "together",
          modelSelection: queueInput(ids, "unused").modelSelection,
          runtimeMode: "full-access",
          clientRequestId: "valid-recovery",
        });
        const store = makeUpstreamStore(yield* SqlClient.SqlClient);
        const [group] = yield* store.listGroups(PROJECT_ID, "valid-recovery");
        yield* store.insertPortRequest({
          projectId: "deleted-project",
          clientRequestId: "deleted-recovery",
          argsHash: "x",
          groups: [{ ...group!, threadId: "deleted-thread", submissionId: "deleted-submission" }],
          links: [],
          at: "2026-10-21T12:00:00.000Z",
        });
        const restarted = yield* fixture.make();
        const sql = yield* SqlClient.SqlClient;
        const count = fixture.host.submissions.length;
        yield* restarted.start;
        yield* restarted.testing.awaitIdle;
        assert.ok(fixture.host.submissions.length > count);
        assert.ok(
          fixture.host.submissions
            .slice(count)
            .every((submission) => submission.submissionId === group!.submissionId),
        );
        assert.equal(
          (yield* sql`SELECT status FROM upstream_port_groups WHERE project_id = 'deleted-project'`)[0]!
            .status,
          "pending",
        );
      }),
  );

  it.effect("stops refreshing the base once automatic decisions have recorded all results", () =>
    Effect.gen(function* () {
      const { fixture, service, ids } = yield* prepareQueue(1, 1);
      yield* service.enqueuePort(queueInput(ids, "recorded-needs-no-fetch"));
      yield* service.testing.awaitIdle;
      const first = (yield* service.getPortQueue({ projectId: PROJECT_ID })).entries[0]!;
      fixture.host.threads = [
        completedThread(first.threadId!, "equivalent-turn", "equivalent-message"),
      ];
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at)
        VALUES ('equivalent-message',${first.threadId},'assistant','UPSTREAM-OUTCOME: equivalent src/a.ts:1',0,'now','now')`;
      yield* service.testing.dispatchQueue(PROJECT_ID);
      const before = fixture.repo.calls.filter((call) => call === "fetch origin/main").length;
      fixture.clock.now = new Date("2026-10-22T12:06:00.000Z");
      const progress = yield* service.getPortQueue({ projectId: PROJECT_ID });
      yield* service.testing.awaitIdle;
      assert.equal(progress.counts.recorded, 1);
      assert.equal(progress.counts.awaitingReview, 0);
      assert.equal(progress.doneOnDefaultBranch, 0);
      assert.equal(
        fixture.repo.calls.filter((call) => call === "fetch origin/main").length,
        before,
      );
    }),
  );

  it.effect("expires definitive isolation failures, unlinks them and continues the queue", () =>
    Effect.gen(function* () {
      const { fixture, service, ids } = yield* prepareQueue(2, 1, () => ["shared.ts"]);
      fixture.host.submitOutcome = () =>
        Effect.fail({
          code: BOOTSTRAP_THREAD_NOT_CREATED_ERROR_CODE,
          message: "Worktree isolation unavailable: unsupported",
        });
      yield* service.enqueuePort({
        ...queueInput(ids, "permanent-isolation"),
        grouping: "separately",
      });
      yield* service.testing.awaitIdle;
      const first = (yield* service.getPortQueue({ projectId: PROJECT_ID })).entries[0]!;
      fixture.clock.now = new Date("2026-10-22T12:03:00.000Z");
      yield* service.testing.dispatchQueue(PROJECT_ID);
      let progress = yield* service.getPortQueue({ projectId: PROJECT_ID });
      assert.equal(progress.counts.needsAttention, 1);
      assert.equal(progress.counts.executing, 1);
      assert.equal(progress.entries[0]!.result, "rejected");
      assert.equal(
        (yield* service.getTopic({ projectId: PROJECT_ID, topicId: first.topics[0]!.topicId })).row
          .state,
        "ready",
      );
      fixture.clock.now = new Date("2026-10-22T12:06:00.000Z");
      yield* service.testing.dispatchQueue(PROJECT_ID);
      progress = yield* service.getPortQueue({ projectId: PROJECT_ID });
      assert.equal(progress.counts.needsAttention, 2);
      assert.equal(progress.counts.executing, 0);
      assert.equal((yield* service.getOverview(PROJECT_ID)).portQueue.hold, null);
      assert.equal(
        (yield* makeUpstreamStore(yield* SqlClient.SqlClient).listGroups(
          PROJECT_ID,
          `queue:${first.entryId}`,
        ))[0]!.status,
        "rejected",
      );
    }),
  );

  for (const paused of [false, true])
    it.effect(`recovers a usage hold while preserving user pause ${paused}`, () =>
      Effect.gen(function* () {
        const { fixture, service, ids } = yield* prepareQueue(1, 1);
        fixture.host.settings = { ...fixture.host.settings, autoResumeUsageLimitedThreads: true };
        Object.assign(fixture.host.host, {
          usageAccounts: Effect.sync(
            () =>
              [
                {
                  providerInstanceId: "claudeAgent",
                  sections: [
                    {
                      kind: "claude-usage",
                      outcome: "available",
                      snapshot: {
                        fetchedAt: "2026-10-22T12:00:00.000Z",
                        data: {
                          subscriptionLabel: null,
                          limitsAvailable: true,
                          windows: [
                            {
                              key: "five_hour",
                              label: "Five hours",
                              utilization: 100,
                              resetsAt: "2026-10-22T12:01:00.000Z",
                            },
                          ],
                          extraUsage: null,
                        },
                      },
                    },
                  ],
                },
              ] as never,
          ),
        });
        yield* service.enqueuePort(queueInput(ids, `usage-hold-${paused}`));
        yield* service.testing.awaitIdle;
        assert.equal((yield* service.getOverview(PROJECT_ID)).portQueue.hold?.kind, "usage");
        assert.equal(fixture.host.submissions.length, 0);
        if (paused) yield* service.controlPortQueue({ projectId: PROJECT_ID, action: "pause" });
        fixture.clock.now = new Date("2026-10-22T12:03:00.000Z");
        yield* service.testing.dispatchQueue(PROJECT_ID);
        assert.equal(fixture.host.submissions.length, paused ? 0 : 1);
        if (paused) {
          assert.equal((yield* service.getOverview(PROJECT_ID)).portQueue.paused, true);
          yield* service.controlPortQueue({ projectId: PROJECT_ID, action: "resume" });
          yield* service.testing.awaitIdle;
          assert.equal(fixture.host.submissions.length, 1);
        }
      }),
    );

  it.effect(
    "holds for a loading provider, recovers automatically and leaves user pause intact",
    () =>
      Effect.gen(function* () {
        const { fixture, service, ids } = yield* prepareQueue(1, 1);
        const providers = yield* fixture.host.host.listProviders;
        let loading = true;
        Object.assign(fixture.host.host, {
          listProviders: Effect.sync(() =>
            providers.map((provider) => ({
              ...provider,
              probeOutcome: loading ? ("loading" as const) : ("success" as const),
            })),
          ),
        });
        yield* service.enqueuePort(queueInput(ids, "loading-provider-hold"));
        yield* service.testing.awaitIdle;
        assert.equal((yield* service.getOverview(PROJECT_ID)).portQueue.hold?.kind, "provider");
        yield* service.controlPortQueue({ projectId: PROJECT_ID, action: "pause" });
        loading = false;
        yield* service.testing.dispatchQueue(PROJECT_ID);
        assert.equal(fixture.host.submissions.length, 0);
        yield* service.controlPortQueue({ projectId: PROJECT_ID, action: "resume" });
        yield* service.testing.awaitIdle;
        assert.equal(fixture.host.submissions.length, 1);
      }),
  );

  it.effect(
    "refreshes base evidence without an open panel and unblocks overlapping ports after merge",
    () =>
      Effect.gen(function* () {
        const { fixture, service, ids } = yield* prepareQueue(2, 2, () => ["shared.ts"]);
        yield* service.enqueuePort({
          ...queueInput(ids, "merge-refresh-request"),
          grouping: "separately",
        });
        yield* service.testing.awaitIdle;
        const first = (yield* service.getPortQueue({ projectId: PROJECT_ID })).entries[0]!;
        fixture.host.threads = [completedThread(first.threadId!, "merge-turn", "merge-message")];
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at)
      VALUES ('merge-message',${first.threadId},'assistant','UPSTREAM-OUTCOME: pr https://github.com/o/f5/pull/42',0,'now','now')`;
        yield* service.testing.dispatchQueue(PROJECT_ID);
        assert.equal(fixture.host.submissions.length, 1);
        const main = fixture.repo.refs.get("refs/remotes/origin/main")!;
        fixture.repo.remoteTips.set(
          "origin/main",
          fixture.repo.commit({
            parent: main,
            subject: "Merge port #42",
            body: `Upstream-Topic: ${first.topics[0]!.topicId}`,
          }),
        );
        fixture.clock.now = new Date("2026-10-22T12:03:00.000Z");
        const before = fixture.repo.calls.filter((call) => call === "fetch origin/main").length;
        yield* service.testing.dispatchQueue(PROJECT_ID);
        yield* service.testing.dispatchQueue(PROJECT_ID);
        assert.equal(fixture.host.submissions.length, 2);
        assert.equal(
          (yield* service.getPortQueue({ projectId: PROJECT_ID })).doneOnDefaultBranch,
          1,
        );
        assert.equal(
          fixture.repo.calls.filter((call) => call === "fetch origin/main").length,
          before + 1,
        );
      }),
  );

  for (const gate of ["preexisting", "setting-off", "invalid"] as const)
    it.effect(`does not auto-record outcomes gated by ${gate}`, () =>
      Effect.gen(function* () {
        const { fixture, service, ids } = yield* prepareQueue(1, 1);
        yield* service.enqueuePort(queueInput(ids, `outcome-gate-${gate}`));
        yield* service.testing.awaitIdle;
        const threadId = (yield* service.getPortQueue({ projectId: PROJECT_ID })).entries[0]!
          .threadId!;
        fixture.host.threads = [completedThread(threadId, "gated-turn", "gated-message")];
        const sql = yield* SqlClient.SqlClient;
        if (gate === "preexisting")
          yield* sql`INSERT INTO upstream_port_outcome_checks(project_id,thread_id,result,checked_at) VALUES (${PROJECT_ID},${threadId},'preexisting','now')`;
        if (gate === "setting-off")
          fixture.host.settings = {
            ...fixture.host.settings,
            upstreamPorts: { ...fixture.host.settings.upstreamPorts, autoRecordOutcomes: false },
          };
        const text =
          gate === "invalid"
            ? "UPSTREAM-OUTCOME: equivalent ../invalid:1"
            : "UPSTREAM-OUTCOME: equivalent src/a.ts:1";
        yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at)
      VALUES ('gated-message',${threadId},'assistant',${text},0,'now','now')`;
        yield* service.testing.dispatchQueue(PROJECT_ID);
        assert.equal(
          (yield* service.getTopic({ projectId: PROJECT_ID, topicId: ids[0]! })).row.topic.status,
          "port",
        );
      }),
    );

  it.effect(
    "retains slots for approval, unquiesced turns, user input and scheduled continuations",
    () =>
      Effect.gen(function* () {
        const { fixture, service, ids } = yield* prepareQueue(2, 1);
        yield* service.enqueuePort({
          ...queueInput(ids, "slot-ownership-request"),
          grouping: "separately",
        });
        yield* service.testing.awaitIdle;
        const threadId = (yield* service.getPortQueue({ projectId: PROJECT_ID })).entries[0]!
          .threadId!;
        const sql = yield* SqlClient.SqlClient;
        const thread = {
          ...(completedThread(threadId, "slot-turn", "slot-message") as unknown as {
            latestTurn: { processingQuiescedAt: string | null };
            pendingUserInputs: Array<{ requestId: string }>;
          }),
        };
        fixture.host.threads = [thread as never];
        yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at)
      VALUES ('slot-message',${threadId},'assistant','UPSTREAM-OUTCOME: blocked review',0,'now','now')`;
        yield* sql`INSERT INTO projection_pending_approvals(request_id,thread_id,status,created_at) VALUES ('approval',${threadId},'pending','now')`;
        yield* service.testing.dispatchQueue(PROJECT_ID);
        assert.equal(fixture.host.submissions.length, 1);
        yield* sql`UPDATE projection_pending_approvals SET status = 'resolved'`;
        thread.latestTurn.processingQuiescedAt = null;
        yield* service.testing.dispatchQueue(PROJECT_ID);
        assert.equal(fixture.host.submissions.length, 1);
        thread.latestTurn.processingQuiescedAt = "2026-10-22T12:01:00Z";
        thread.pendingUserInputs = [{ requestId: "input" }];
        yield* service.testing.dispatchQueue(PROJECT_ID);
        assert.equal(fixture.host.submissions.length, 1);
        thread.pendingUserInputs = [];
        yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model,created_at,last_interaction_at,updated_at)
      VALUES (${threadId},${PROJECT_ID},'port','model','now','now','now')`;
        yield* sql`INSERT INTO next_turn_queue(item_id,thread_id,submission_id,command_id,message_id,position,status,not_before,schedule_reason,command_json,created_at,updated_at)
      VALUES ('continuation',${threadId},'continuation','continuation','next-message',0,'queued','2026-10-23T00:00:00Z','usage_limit_reset','{}','now','now')`;
        yield* service.testing.dispatchQueue(PROJECT_ID);
        assert.equal(fixture.host.submissions.length, 1);
        yield* sql`UPDATE next_turn_queue SET deleted_at = 'now'`;
        yield* service.testing.dispatchQueue(PROJECT_ID);
        assert.equal(fixture.host.submissions.length, 2);
      }),
  );

  it.effect("pauses after two consecutive errors and resumes immediately", () =>
    Effect.gen(function* () {
      const { fixture, service, ids } = yield* prepareQueue(3, 1);
      yield* service.enqueuePort({
        ...queueInput(ids, "two-errors-request"),
        grouping: "separately",
      });
      yield* service.testing.awaitIdle;
      for (let index = 0; index < 2; index++) {
        const entry = (yield* service.getPortQueue({ projectId: PROJECT_ID })).entries[index]!;
        fixture.host.threads = [
          ...fixture.host.threads,
          completedThread(
            entry.threadId!,
            `error-turn-${index}`,
            `error-message-${index}`,
            "error",
          ),
        ];
        yield* service.testing.dispatchQueue(PROJECT_ID);
      }
      assert.equal(fixture.host.submissions.length, 2);
      assert.equal((yield* service.getOverview(PROJECT_ID)).portQueue.paused, true);
      yield* service.controlPortQueue({ projectId: PROJECT_ID, action: "resume" });
      yield* service.testing.awaitIdle;
      assert.equal(fixture.host.submissions.length, 3);
      assert.equal((yield* service.getOverview(PROJECT_ID)).portQueue.paused, false);
    }),
  );

  it.effect(
    "honors cancellation during build and removes a manually started member's file keys",
    () =>
      Effect.gen(function* () {
        const { fixture, service, ids } = yield* prepareQueue(3, 2);
        yield* service.controlPortQueue({ projectId: PROJECT_ID, action: "pause" });
        yield* service.enqueuePort(queueInput(ids, "manual-removes-member"));
        yield* service.testing.awaitIdle;
        yield* service.startPort({
          projectId: PROJECT_ID,
          topicIds: [ids[0]!],
          grouping: "together",
          modelSelection: queueInput(ids, "unused").modelSelection,
          runtimeMode: "full-access",
          clientRequestId: "manual-port-request",
        });
        yield* service.controlPortQueue({ projectId: PROJECT_ID, action: "resume" });
        yield* service.testing.awaitIdle;
        assert.equal(fixture.host.submissions.length, 2);
        assert.equal((yield* service.getPortQueue({ projectId: PROJECT_ID })).counts.cancelled, 1);
        const fresh = yield* prepareQueue(1, 1);
        Object.assign(fresh.fixture.host.host, {
          resolveAvailableBranchName: (_cwd: string, branch: string) =>
            fresh.service
              .dequeuePort({ projectId: PROJECT_ID, topicIds: fresh.ids })
              .pipe(Effect.as(branch)),
        });
        yield* fresh.service.enqueuePort(queueInput(fresh.ids, "cancel-during-build"));
        yield* fresh.service.testing.awaitIdle;
        assert.equal(fresh.fixture.host.submissions.length, 0);
      }),
  );

  it.effect(
    "re-triages failed Inbox topics with superseding suggestions and confident skip decisions",
    () =>
      Effect.gen(function* () {
        const fixture = yield* setup({ count: 0 });
        const service = yield* fixture.make();
        const sql = yield* SqlClient.SqlClient;
        const store = makeUpstreamStore(sql);
        yield* service.decide({
          projectId: PROJECT_ID,
          topicIds: ["pr-1"],
          decision: { kind: "inbox" },
        });
        const failedSuggestion = {
          status: "port" as const,
          reason: "Failed",
          userImpact: "medium" as const,
          confidence: 0,
          areas: [],
          model: "test",
          triageError: "timeout",
        };
        yield* store.recordOps(
          PROJECT_ID,
          [
            {
              opId: "failed-suggestion",
              op: {
                kind: "suggestion",
                topicId: "pr-1",
                title: "Old title",
                summary: "",
                suggestion: failedSuggestion,
              },
            },
          ],
          fixture.clock.now.toISOString(),
        );
        assert.equal((yield* service.getOverview(PROJECT_ID)).triageFailedCount, 1);
        assert.equal(
          (yield* service
            .run({ projectId: PROJECT_ID, kind: "retriage", triage: "rules-only" })
            .pipe(Effect.flip)).code,
          "invalid",
        );
        fixture.host.triage = triageAll(() => ({
          suggestion: "skip",
          reasonKey: "maintenance",
          reason: "No user impact",
          confidence: 0.99,
        }));
        yield* service.run({ projectId: PROJECT_ID, kind: "retriage", triage: "llm" });
        yield* service.testing.awaitIdle;
        const topic = (yield* service.getTopic({ projectId: PROJECT_ID, topicId: "pr-1" })).row
          .topic;
        assert.equal(topic.status, "skip");
        assert.equal(topic.decidedBy, "llm");
        assert.equal(topic.suggestion?.triageError, undefined);
        assert.equal((yield* service.getOverview(PROJECT_ID)).triageFailedCount, 0);
        assert.equal((yield* service.getOverview(PROJECT_ID)).lastRun?.kind, "retriage");
        assert.ok(
          fixture.host.published
            .filter((event) => event.reason === "run-finished")
            .every((event) => event.newInboxCount === undefined),
        );
        assert.deepStrictEqual(
          yield* sql`SELECT state FROM upstream_ledger_ops WHERE op_id = 'failed-suggestion'`,
          [{ state: "superseded" }],
        );
      }),
  );

  it.effect("keeps a two-commit failed topic whole even with chunkSize one", () =>
    Effect.gen(function* () {
      const fixture = yield* setup({ count: 2 });
      fixture.host.triage = (prompt) =>
        triageAll(() => ({}))(prompt).pipe(
          Effect.map((result) => ({
            groups: [
              { ...result.groups[0]!, commits: result.groups.flatMap((group) => group.commits) },
            ],
          })),
        );
      const first = yield* fixture.make();
      yield* first.run({ projectId: PROJECT_ID, kind: "upstream", triage: "llm" });
      yield* first.testing.awaitIdle;
      const topic = (yield* first.listTopics({ projectId: PROJECT_ID, list: "inbox" })).topics.find(
        (row) => row.topic.id !== "pr-1",
      )!.topic;
      const sql = yield* SqlClient.SqlClient;
      yield* makeUpstreamStore(sql).recordOps(
        PROJECT_ID,
        [
          {
            opId: "failed-multi",
            op: {
              kind: "suggestion",
              topicId: topic.id,
              title: topic.title,
              summary: topic.summary,
              suggestion: { ...topic.suggestion!, triageError: "bad JSON" },
            },
          },
        ],
        fixture.clock.now.toISOString(),
      );
      const chunks: number[] = [];
      fixture.host.triage = (prompt) => {
        chunks.push([...prompt.matchAll(/^commit [0-9a-f]{40}$/gm)].length);
        return triageAll(() => ({}))(prompt);
      };
      const service = yield* fixture.make(undefined, { chunkSize: 1 });
      yield* service.run({ projectId: PROJECT_ID, kind: "retriage", triage: "llm" });
      yield* service.testing.awaitIdle;
      assert.deepStrictEqual(chunks, [2]);
      assert.equal(
        (yield* service.getTopic({ projectId: PROJECT_ID, topicId: topic.id })).members.length,
        2,
      );
      assert.equal((yield* service.getOverview(PROJECT_ID)).lastRun?.status, "succeeded");
    }),
  );

  for (const count of [21, 201, 1531])
    it.effect(`queues all ${count} Ready topics beyond loaded pages`, () =>
      Effect.gen(function* () {
        const { fixture, service, ids } = yield* prepareQueue(count);
        yield* service.controlPortQueue({ projectId: PROJECT_ID, action: "pause" });
        const input = {
          ...queueInput(ids, `volume-request-${count}`),
          target: { kind: "all-ready" as const },
        };
        const queued = yield* service.enqueuePort(input);
        yield* service.testing.awaitIdle;
        assert.equal(queued.queuedTopicIds.length, count);
        assert.equal(queued.queuedThreads, Math.ceil(count / 5));
        assert.deepStrictEqual(yield* service.enqueuePort(input), queued);
        assert.equal(
          (yield* service.enqueuePort({ ...input, batchSize: 10 }).pipe(Effect.flip)).code,
          "conflict",
        );
        assert.equal((yield* service.getOverview(PROJECT_ID)).portQueue.queuedTopics, count);
        assert.equal(fixture.host.submissions.length, 0);
        assert.equal(
          (yield* service.enqueuePort({ ...input, clientRequestId: "second-enqueue" })).skipped
            .length,
          count,
        );
      }),
    );

  it.effect(
    "refills 53 topics in six batches at concurrency two while the earlier PR is unmerged",
    () =>
      Effect.gen(function* () {
        const { fixture, service, ids } = yield* prepareQueue(53);
        const sql = yield* SqlClient.SqlClient;
        const before = yield* service.listTopics({
          projectId: PROJECT_ID,
          list: "ready",
          limit: 10,
        });
        yield* service.enqueuePort(queueInput(ids, "fifty-three-topics", 10));
        yield* service.testing.awaitIdle;
        let queue = yield* service.getPortQueue({ projectId: PROJECT_ID });
        assert.deepStrictEqual(
          queue.entries.map((entry) => entry.topics.length),
          [10, 10, 10, 10, 10, 3],
        );
        assert.equal(fixture.host.submissions.length, 2);
        assert.equal(queue.counts.executing, 20);
        assert.equal(
          (yield* service.listTopics({
            projectId: PROJECT_ID,
            list: "ready",
            limit: 10,
            cursor: before.nextCursor!,
          })).status,
          "ok",
        );
        assert.equal(
          (yield* service.listTopics({ projectId: PROJECT_ID, list: "ready" })).contentRevision,
          before.contentRevision,
        );
        const threadId = queue.entries[0]!.threadId!;
        fixture.host.threads = [completedThread(threadId, "turn-1", "message-1")];
        yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at)
      VALUES ('message-1',${threadId},'assistant','UPSTREAM-OUTCOME: pr https://github.com/o/f5/pull/42',0,'now','now')`;
        yield* service.testing.dispatchQueue(PROJECT_ID);
        queue = yield* service.getPortQueue({ projectId: PROJECT_ID });
        assert.equal(fixture.host.submissions.length, 3);
        assert.equal(queue.counts.awaitingReview, 10);
        assert.equal(queue.doneOnDefaultBranch, 0);
        const command = fixture.host.submissions[0]!.command;
        assert.equal(command.bootstrap?.prepareWorktree?.requireWorktree, true);
        const restarted = yield* fixture.make();
        yield* restarted.testing.dispatchQueue(PROJECT_ID);
        assert.equal(fixture.host.submissions.length, 3);
        yield* restarted.controlPortQueue({ projectId: PROJECT_ID, action: "clear" });
        yield* restarted.testing.awaitIdle;
        assert.equal(
          (yield* restarted.getPortQueue({ projectId: PROJECT_ID })).counts.cancelled,
          23,
        );
      }),
  );

  it.effect(
    "skips file conflicts, keeps awaiting-merge files blocked, and permits a single override",
    () =>
      Effect.gen(function* () {
        const { fixture, service, ids } = yield* prepareQueue(3, 2, (index) => [
          index < 2 ? "shared.ts" : "other.ts",
        ]);
        yield* service.controlPortQueue({ projectId: PROJECT_ID, action: "pause" });
        yield* service.enqueuePort({
          ...queueInput(ids, "file-conflict-request"),
          grouping: "separately",
        });
        yield* service.testing.awaitIdle;
        yield* service.controlPortQueue({ projectId: PROJECT_ID, action: "resume" });
        yield* service.testing.awaitIdle;
        let queue = yield* service.getPortQueue({ projectId: PROJECT_ID });
        assert.equal(queue.entries.filter((entry) => entry.status === "started").length, 2);
        const waiting = queue.entries.find((entry) => entry.status === "queued")!;
        assert.equal(waiting.waitingOn.length, 1);
        const first = queue.entries.find(
          (entry) => entry.threadId === waiting.waitingOn[0]!.threadId,
        )!;
        fixture.host.threads = [completedThread(first.threadId!, "turn-files", "message-files")];
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at)
      VALUES ('message-files',${first.threadId},'assistant','UPSTREAM-OUTCOME: pr https://github.com/o/f5/pull/42',0,'now','now')`;
        yield* service.testing.dispatchQueue(PROJECT_ID);
        assert.equal(fixture.host.submissions.length, 2);
        assert.equal((yield* service.getOverview(PROJECT_ID)).portQueue.waitingOnFiles, 1);
        yield* service.controlPortQueue({
          projectId: PROJECT_ID,
          action: "ignore-conflicts",
          entryId: waiting.entryId,
        });
        yield* service.testing.awaitIdle;
        queue = yield* service.getPortQueue({ projectId: PROJECT_ID });
        assert.equal(fixture.host.submissions.length, 3);
        assert.equal(
          queue.entries.find((entry) => entry.entryId === waiting.entryId)!.ignoreConflicts,
          true,
        );
      }),
  );

  it.effect(
    "records only a scoped batch outcome from its settled turn and never a later message",
    () =>
      Effect.gen(function* () {
        const { fixture, service, ids } = yield* prepareQueue(2, 1);
        yield* service.enqueuePort(queueInput(ids, "scoped-outcome-request"));
        yield* service.testing.awaitIdle;
        const threadId = (yield* service.getPortQueue({ projectId: PROJECT_ID })).entries[0]!
          .threadId!;
        fixture.host.threads = [completedThread(threadId, "turn-outcome", "owned-message")];
        const sql = yield* SqlClient.SqlClient;
        const text = `UPSTREAM-OUTCOME ${ids[0]}: equivalent apps/server/a.ts:12\nUPSTREAM-OUTCOME: pr https://github.com/o/f5/pull/42`;
        yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at)
      VALUES ('owned-message',${threadId},'assistant',${text},0,'2026-10-22','2026-10-22')`;
        yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at)
      VALUES ('later-message',${threadId},'assistant','UPSTREAM-OUTCOME: not-applicable wrong message',0,'2026-10-23','2026-10-23')`;
        yield* service.testing.dispatchQueue(PROJECT_ID);
        const done = yield* service.getTopic({ projectId: PROJECT_ID, topicId: ids[0]! });
        assert.equal(done.row.topic.status, "equivalent");
        assert.equal(done.row.topic.decidedBy, "llm");
        const progress = yield* service.getPortQueue({ projectId: PROJECT_ID });
        assert.equal(progress.counts.recorded, 1);
        assert.equal(progress.doneOnDefaultBranch, 0);
        assert.equal(progress.counts.awaitingReview, 1);
        assert.ok(!done.row.topic.equivalence?.f5Refs.includes("#42"));
        assert.equal(
          (yield* service.getTopic({ projectId: PROJECT_ID, topicId: ids[1]! })).row.state,
          "in-progress",
        );
        const seq = yield* makeUpstreamStore(sql).maxSeq(PROJECT_ID);
        yield* service.testing.dispatchQueue(PROJECT_ID);
        assert.equal(yield* makeUpstreamStore(sql).maxSeq(PROJECT_ID), seq);
      }),
  );

  it.effect(
    "retries null and isolation deliveries with the original identity, without starting more work",
    () =>
      Effect.gen(function* () {
        const { fixture, service, ids } = yield* prepareQueue(3, 1);
        fixture.host.submitOutcome = () =>
          Effect.fail({
            code: BOOTSTRAP_THREAD_NOT_CREATED_ERROR_CODE,
            message: "Worktree isolation unavailable: unsupported",
          });
        yield* service.enqueuePort({
          ...queueInput(ids, "isolation-request"),
          grouping: "separately",
        });
        yield* service.testing.awaitIdle;
        assert.equal((yield* service.getOverview(PROJECT_ID)).portQueue.hold?.kind, "isolation");
        const submissionId = fixture.host.submissions[0]!.submissionId;
        fixture.host.submitOutcome = () => Effect.succeed(null);
        yield* service.testing.dispatchQueue(PROJECT_ID);
        assert.equal(fixture.host.submissions.at(-1)!.submissionId, submissionId);
        assert.equal((yield* service.getPortQueue({ projectId: PROJECT_ID })).counts.executing, 1);
      }),
  );
});

layer("upstream ports service", (it) => {
  it.effect("records decisions locally with no network and bumps epochs on reopen", () =>
    Effect.gen(function* () {
      const fixture = yield* setup();
      const service = yield* fixture.make();
      const result = yield* service.decide({
        projectId: PROJECT_ID,
        topicIds: ["pr-1"],
        decision: { kind: "port", scope: "Only the panel" },
      });
      assert.deepStrictEqual(result.updated, ["pr-1"]);
      assert.deepStrictEqual(fixture.repo.calls, []);
      assert.deepStrictEqual(fixture.gh.calls, []);
      const ready = yield* service.listTopics({ projectId: PROJECT_ID, list: "ready" });
      assert.strictEqual(ready.topics[0]!.topic.scope, "Only the panel");
      const again = yield* service.decide({
        projectId: PROJECT_ID,
        topicIds: ["pr-1"],
        decision: { kind: "port", scope: "Only the panel" },
      });
      assert.deepStrictEqual(again.unchanged, ["pr-1"]);
      yield* service.decide({
        projectId: PROJECT_ID,
        topicIds: ["pr-1"],
        decision: { kind: "inbox" },
      });
      const detail = yield* service.getTopic({ projectId: PROJECT_ID, topicId: "pr-1" });
      assert.strictEqual(detail.row.topic.epoch, 2);
      assert.strictEqual(detail.row.topic.scope, undefined);
      assert.strictEqual(detail.row.state, "inbox");
      assert.ok(fixture.host.published.some((entry) => entry.reason === "ledger-updated"));
      assert.deepStrictEqual(
        detail.history.map((entry) => [entry.kind, entry.status, entry.epoch, entry.publication]),
        [
          ["created", undefined, 1, "published"],
          ["decided", "port", 1, "superseded"],
          ["decided", "inbox", 2, "pending"],
        ],
      );
    }),
  );

  it.effect("undoes a decision once, keeping the epoch a reopen bumped", () =>
    Effect.gen(function* () {
      const fixture = yield* setup();
      const service = yield* fixture.make();
      const input = { projectId: PROJECT_ID, topicIds: ["pr-1"] };
      const ready = yield* service.decide({ ...input, decision: { kind: "port", scope: "Panel" } });
      const reopen = yield* service.decide({ ...input, decision: { kind: "inbox" } });
      assert.strictEqual(
        (yield* service.getTopic({ ...input, topicId: "pr-1" })).row.topic.epoch,
        2,
      );

      const undone = yield* service.undoDecisions({ ...input, undoToken: reopen.undoToken! });
      assert.deepStrictEqual(
        [undone.updated, undone.unchanged, undone.undoToken],
        [["pr-1"], [], null],
      );
      const restored = (yield* service.getTopic({ ...input, topicId: "pr-1" })).row;
      assert.strictEqual(restored.state, "ready");
      // Epochs only grow: the reopen may already be in the ledger pull request.
      assert.strictEqual(restored.topic.epoch, 2);
      assert.strictEqual(restored.topic.scope, "Panel");
      const reused = yield* Effect.flip(
        service.undoDecisions({ ...input, undoToken: reopen.undoToken! }),
      );
      assert.deepStrictEqual(
        [reused.code, reused.message],
        ["not-found", "This undo has expired."],
      );

      yield* service.undoDecisions({ ...input, undoToken: ready.undoToken! });
      const original = (yield* service.getTopic({ ...input, topicId: "pr-1" })).row.topic;
      assert.deepStrictEqual([original.status, original.decidedBy], ["inbox", undefined]);

      // A topic decided again since the token was minted stays as it is.
      const watch = yield* service.decide({ ...input, decision: { kind: "watch" } });
      yield* service.decide({ ...input, decision: { kind: "port" } });
      const stale = yield* service.undoDecisions({ ...input, undoToken: watch.undoToken! });
      assert.deepStrictEqual([stale.updated, stale.unchanged], [[], ["pr-1"]]);

      const late = yield* service.decide({ ...input, decision: { kind: "watch" } });
      fixture.clock.now = new Date(fixture.clock.now.getTime() + 16 * 60_000);
      const expired = yield* Effect.flip(
        service.undoDecisions({ ...input, undoToken: late.undoToken! }),
      );
      assert.strictEqual(expired.code, "not-found");
      const noop = yield* service.decide({ ...input, decision: { kind: "watch" } });
      assert.strictEqual(noop.undoToken, null);
    }),
  );

  it.effect("does not let an undo or a stale decision overwrite one recorded meanwhile", () =>
    Effect.gen(function* () {
      const fixture = yield* setup();
      const service = yield* fixture.make();
      const input = { projectId: PROJECT_ID, topicIds: ["pr-1"] };
      const tick = () => {
        fixture.clock.now = new Date(fixture.clock.now.getTime() + 1_000);
      };
      const watch = yield* service.decide({ ...input, decision: { kind: "watch" } });
      tick();
      // Another window marks the topic ready while this undo waits for the lock.
      fixture.host.beforeNextLock = service.decide({ ...input, decision: { kind: "port" } });
      const raced = yield* service.undoDecisions({ ...input, undoToken: watch.undoToken! });
      assert.deepStrictEqual([raced.updated, raced.unchanged], [[], ["pr-1"]]);
      assert.strictEqual(
        (yield* service.getTopic({ ...input, topicId: "pr-1" })).row.topic.status,
        "port",
      );

      // Another window reopens the topic while a decision made at the old epoch waits for the lock.
      tick();
      fixture.host.beforeNextLock = service.decide({ ...input, decision: { kind: "inbox" } });
      const stale = yield* Effect.flip(
        service.decide({ ...input, decision: { kind: "declined", reason: "Not for f5" } }),
      );
      assert.strictEqual(stale.code, "conflict");
      const reopened = (yield* service.getTopic({ ...input, topicId: "pr-1" })).row.topic;
      assert.deepStrictEqual([reopened.status, reopened.epoch], ["inbox", 2]);

      // Watch, Mark ready, then Watch again: the first token does not come back to life.
      tick();
      const first = yield* service.decide({ ...input, decision: { kind: "watch" } });
      tick();
      yield* service.decide({ ...input, decision: { kind: "port" } });
      tick();
      yield* service.decide({ ...input, decision: { kind: "watch" } });
      const revived = yield* service.undoDecisions({ ...input, undoToken: first.undoToken! });
      assert.deepStrictEqual([revived.updated, revived.unchanged], [[], ["pr-1"]]);
    }),
  );

  it.effect("keeps every batch of one action under a single undo token", () =>
    Effect.gen(function* () {
      const fixture = yield* setup();
      const service = yield* fixture.make();
      // More batches than the per-project token limit: joining keeps them all.
      let token: string | undefined;
      for (let batch = 0; batch < 22; batch += 1) {
        const result = yield* service.decide({
          projectId: PROJECT_ID,
          topicIds: ["pr-1"],
          decision: { kind: batch % 2 === 0 ? "watch" : "port" },
          ...(token ? { undoToken: token } : {}),
        });
        assert.ok(result.undoToken);
        if (token) assert.strictEqual(result.undoToken, token);
        token = result.undoToken;
        fixture.clock.now = new Date(fixture.clock.now.getTime() + 1_000);
      }
      const undone = yield* service.undoDecisions({ projectId: PROJECT_ID, undoToken: token! });
      // The newest batch is undone; the earlier ones were superseded by it.
      assert.deepStrictEqual(undone.updated, ["pr-1"]);
      assert.strictEqual(
        (yield* service.getTopic({ projectId: PROJECT_ID, topicId: "pr-1" })).row.topic.status,
        "watch",
      );
    }),
  );

  it.effect("lists a topic's changed files and whether f5 has each path", () =>
    Effect.gen(function* () {
      const fixture = yield* setup();
      const service = yield* fixture.make();
      const files = yield* service.getTopicFiles({ projectId: PROJECT_ID, topicId: "pr-1" });
      assert.deepStrictEqual(files, {
        commits: [
          {
            sha: fixture.target0,
            available: true,
            files: [
              {
                path: "apps/web/settings.tsx",
                added: 1,
                deleted: 0,
                existsInF5: true,
                diffAnchor: `diff-${sha256Hex("apps/web/settings.tsx")}`,
              },
            ],
            totalFiles: 1,
            truncated: false,
          },
        ],
        totalCommits: 1,
        totals: { files: 1, added: 1, deleted: 0, existingInF5: 1 },
      });
      // A timeout is reported, not mistaken for commits missing from the clone.
      fixture.repo.numstatTimeouts = 1;
      const timedOut = yield* Effect.flip(
        service.getTopicFiles({ projectId: PROJECT_ID, topicId: "pr-1" }),
      );
      assert.match(timedOut.message, /timed out/u);
      fixture.repo.commits.delete(fixture.target0);
      const missing = yield* service.getTopicFiles({ projectId: PROJECT_ID, topicId: "pr-1" });
      assert.strictEqual(missing.commits[0]!.available, false);
      const unknown = yield* Effect.flip(
        service.getTopicFiles({ projectId: PROJECT_ID, topicId: "pr-404" }),
      );
      assert.strictEqual(unknown.code, "not-found");
    }),
  );

  it.effect("runs rules-only triage into one interval op with rule skips", () =>
    Effect.gen(function* () {
      const fixture = yield* setup({
        count: 3,
        paths: (index) => (index === 1 ? ["apps/mobile/app.tsx"] : [`apps/server/f${index}.ts`]),
      });
      const service = yield* fixture.make();
      yield* service.run({ projectId: PROJECT_ID, kind: "upstream", triage: "rules-only" });
      yield* service.testing.awaitIdle;
      const overview = yield* service.getOverview(PROJECT_ID);
      assert.strictEqual(overview.lastRun?.status, "succeeded");
      assert.strictEqual(overview.lastRun?.commitCount, 3);
      assert.strictEqual(overview.trackedThrough, fixture.upstream.at(-1));
      assert.strictEqual(overview.publication.unpublishedOps, 1);
      assert.strictEqual(overview.counts.inbox, 3);
      assert.strictEqual(overview.counts.skipped, 1);
      const skipped = yield* service.listTopics({ projectId: PROJECT_ID, list: "skipped" });
      assert.strictEqual(skipped.topics[0]!.topic.reasonKey, "mobile");
      assert.strictEqual(skipped.topics[0]!.topic.decidedBy, "rule");
      assert.ok(
        fixture.host.published.some(
          (entry) => entry.reason === "run-finished" && entry.newInboxCount === 2,
        ),
      );
    }),
  );

  it.effect("starts one run when two starts race, and the database allows one running row", () =>
    Effect.gen(function* () {
      const fixture = yield* setup();
      // Hold the first run in triage so it is still active when the second start runs.
      const gate = yield* Deferred.make<void>();
      const triage = triageAll(() => ({}));
      fixture.host.triage = (prompt) => Deferred.await(gate).pipe(Effect.andThen(triage(prompt)));
      const service = yield* fixture.make();
      const start = service
        .run({ projectId: PROJECT_ID, kind: "upstream", triage: "llm" })
        .pipe(Effect.result);
      const results = yield* Effect.all([start, start], { concurrency: "unbounded" });
      yield* Deferred.succeed(gate, undefined);
      yield* service.testing.awaitIdle;
      // Either start may win; exactly one must, and the other is busy.
      assert.deepStrictEqual(results.map((result) => result._tag).toSorted(), [
        "Failure",
        "Success",
      ]);
      const failure = results.find((result) => result._tag === "Failure")!;
      assert.strictEqual(failure._tag === "Failure" ? failure.failure.code : null, "busy");
      const sql = yield* SqlClient.SqlClient;
      const runs = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM upstream_port_runs`;
      assert.strictEqual(runs[0]!.count, 1);

      const insert = (runId: string) =>
        sql`INSERT INTO upstream_port_runs (run_id, project_id, kind, trigger, triage, started_at, status)
          VALUES (${runId}, 'other', 'upstream', 'manual', 'rules-only', '2026-10-22', 'running')`;
      yield* insert("running-1");
      assert.strictEqual((yield* insert("running-2").pipe(Effect.result))._tag, "Failure");
    }),
  );

  it.effect("auto-skips confident LLM skips and keeps the rest in the inbox", () =>
    Effect.gen(function* () {
      const fixture = yield* setup({ count: 3 });
      fixture.host.triage = triageAll((sha) =>
        sha === fixture.upstream[0]
          ? { suggestion: "skip", reasonKey: "maintenance", confidence: 0.85 }
          : sha === fixture.upstream[1]
            ? {
                suggestion: "skip",
                reasonKey: "maintenance",
                confidence: 0.9,
                question: "Is this used?",
              }
            : {},
      );
      const service = yield* fixture.make();
      yield* service.run({ projectId: PROJECT_ID, kind: "upstream", triage: "llm" });
      yield* service.testing.awaitIdle;
      const skipped = yield* service.listTopics({
        projectId: PROJECT_ID,
        list: "skipped",
        filter: { decidedBy: "llm" },
      });
      assert.strictEqual(skipped.topics.length, 1);
      const questions = yield* service.listTopics({
        projectId: PROJECT_ID,
        list: "inbox",
        filter: { hasQuestion: true },
      });
      assert.strictEqual(questions.topics[0]!.topic.suggestion?.question, "Is this used?");
      const overview = yield* service.getOverview(PROJECT_ID);
      assert.strictEqual(overview.lastRun?.llmCalls, 1);
      assert.strictEqual(overview.lastRun?.autoDecidedCount, 1);

      // Confirming the automatic skip unchanged attributes it to the user, once.
      const topic = skipped.topics[0]!.topic;
      const confirm = service.decide({
        projectId: PROJECT_ID,
        topicIds: [topic.id],
        decision: { kind: "skip", reasonKey: topic.reasonKey!, reason: topic.reason! },
      });
      assert.deepStrictEqual((yield* confirm).updated, [topic.id]);
      const confirmed = yield* service.getTopic({ projectId: PROJECT_ID, topicId: topic.id });
      assert.strictEqual(confirmed.row.topic.decidedBy, "user");
      assert.deepStrictEqual((yield* confirm).unchanged, [topic.id]);
    }),
  );

  it.effect("stops at the call budget with a partial run and resumes from the recorded chunk", () =>
    Effect.gen(function* () {
      const fixture = yield* setup({ count: 12 });
      fixture.host.triage = triageAll(() => ({}));
      const service = yield* fixture.make(undefined, { chunkSize: 5, callBudget: 1 });
      yield* service.run({ projectId: PROJECT_ID, kind: "upstream", triage: "llm" });
      yield* service.testing.awaitIdle;
      let overview = yield* service.getOverview(PROJECT_ID);
      assert.strictEqual(overview.lastRun?.status, "partial");
      assert.strictEqual(overview.lastRun?.remainingCount, 7);
      assert.strictEqual(overview.trackedThrough, fixture.upstream[4]);
      assert.strictEqual(overview.untriagedUpstreamCount, 7);
      yield* service.run({ projectId: PROJECT_ID, kind: "upstream", triage: "rules-only" });
      yield* service.testing.awaitIdle;
      overview = yield* service.getOverview(PROJECT_ID);
      assert.strictEqual(overview.lastRun?.status, "succeeded");
      assert.strictEqual(overview.trackedThrough, fixture.upstream.at(-1));
      assert.strictEqual(overview.publication.unpublishedOps, 3);
    }),
  );

  it.effect(
    "fails with provider-unavailable after three provider failures, keeping earlier chunks",
    () =>
      Effect.gen(function* () {
        const fixture = yield* setup({ count: 6 });
        let calls = 0;
        fixture.host.triage = (prompt) => {
          calls += 1;
          return calls === 1
            ? triageAll(() => ({}))(prompt)
            : Effect.fail(
                new TextGenerationError({ operation: "t", detail: "429", kind: "limit" }),
              );
        };
        const service = yield* fixture.make(undefined, { chunkSize: 2, batchSize: 1 });
        yield* service.run({ projectId: PROJECT_ID, kind: "upstream", triage: "llm" });
        yield* service.testing.awaitIdle;
        const overview = yield* service.getOverview(PROJECT_ID);
        assert.strictEqual(overview.lastRun?.status, "failed");
        assert.strictEqual(overview.lastRun?.failureKind, "provider-unavailable");
        assert.strictEqual(overview.publication.unpublishedOps, 1);
        assert.strictEqual(overview.trackedThrough, fixture.upstream[1]);
      }),
  );

  it.effect("retries a timed-out chunk once, then fails the run with git-timeout", () =>
    Effect.gen(function* () {
      const fixture = yield* setup({ count: 2 });
      fixture.repo.numstatTimeouts = 1;
      const service = yield* fixture.make();
      yield* service.run({ projectId: PROJECT_ID, kind: "upstream", triage: "rules-only" });
      yield* service.testing.awaitIdle;
      assert.strictEqual((yield* service.getOverview(PROJECT_ID)).lastRun?.status, "succeeded");
      fixture.repo.refs.set(
        "refs/remotes/upstream/main",
        fixture.repo.commit({ parent: fixture.upstream.at(-1)!, subject: "More", paths: ["x.ts"] }),
      );
      fixture.repo.numstatTimeouts = 2;
      yield* service.run({ projectId: PROJECT_ID, kind: "upstream", triage: "rules-only" });
      yield* service.testing.awaitIdle;
      const failed = (yield* service.getOverview(PROJECT_ID)).lastRun;
      assert.strictEqual(failed?.failureKind, "git-timeout");
    }),
  );

  it.effect("rejects runs when the remote is missing or mismatched, and adds it", () =>
    Effect.gen(function* () {
      const fixture = yield* setup();
      fixture.repo.remotes.delete("upstream");
      const service = yield* fixture.make();
      assert.strictEqual((yield* service.getOverview(PROJECT_ID)).remoteStatus, "missing");
      const error = yield* service
        .run({ projectId: PROJECT_ID, kind: "upstream", triage: "rules-only" })
        .pipe(Effect.flip);
      assert.strictEqual(error.code, "invalid");
      yield* service.addRemote(PROJECT_ID);
      assert.strictEqual((yield* service.getOverview(PROJECT_ID)).remoteStatus, "ok");
      fixture.repo.remotes.set("upstream", "git@github.com:someone/else.git");
      assert.strictEqual((yield* service.getOverview(PROJECT_ID)).remoteStatus, "mismatch");
    }),
  );

  it.effect("keeps a second profile read-only until it takes over", () =>
    Effect.gen(function* () {
      const fixture = yield* setup();
      const first = yield* fixture.make();
      yield* first.decide({
        projectId: PROJECT_ID,
        topicIds: ["pr-1"],
        decision: { kind: "watch" },
      });
      const second = yield* fixture.make({
        profileId: "p2",
        stateDir: "/state/p2",
        hostname: "host",
      });
      const error = yield* second
        .decide({ projectId: PROJECT_ID, topicIds: ["pr-1"], decision: { kind: "port" } })
        .pipe(Effect.flip);
      assert.strictEqual(error.code, "read-only");
      assert.strictEqual(
        (yield* second.getOverview(PROJECT_ID)).writer.managedByThisProfile,
        false,
      );
      yield* second.takeOverWriter(PROJECT_ID);
      yield* second.decide({
        projectId: PROJECT_ID,
        topicIds: ["pr-1"],
        decision: { kind: "port" },
      });
      const lost = yield* first
        .decide({ projectId: PROJECT_ID, topicIds: ["pr-1"], decision: { kind: "inbox" } })
        .pipe(Effect.flip);
      assert.strictEqual(lost.code, "read-only");
    }),
  );

  it.effect(
    "publishes to one rolling PR, detects a squash merge and replays leftovers on a new branch",
    () =>
      Effect.gen(function* () {
        const fixture = yield* setup();
        const service = yield* fixture.make();
        yield* service.decide({
          projectId: PROJECT_ID,
          topicIds: ["pr-1"],
          decision: { kind: "port" },
        });
        yield* service.testing.publishNow(PROJECT_ID);
        let overview = yield* service.getOverview(PROJECT_ID);
        assert.strictEqual(overview.publication.prNumber, 100);
        assert.ok(overview.publication.branch?.startsWith("f5/upstream-ledger-"));
        assert.strictEqual(fixture.gh.prs[0]!.title, "Track upstream t3code changes (2026-10-22)");
        assert.ok(!fixture.gh.prs[0]!.body.includes("—"));
        const branchTip = fixture.repo.refs.get(`refs/heads/${overview.publication.branch}`)!;
        const firstBranch = overview.publication.branch!;

        // A second decision lands on the same branch and refreshes the PR body.
        yield* service.decide({
          projectId: PROJECT_ID,
          topicIds: ["pr-1"],
          decision: { kind: "port", scope: "API only" },
        });
        fixture.clock.now = new Date(fixture.clock.now.getTime() + 3 * 60_000);
        yield* service.testing.publishNow(PROJECT_ID);
        assert.strictEqual(fixture.gh.prs.length, 1);
        assert.ok(fixture.gh.calls.includes("update 100"));

        // Squash-merge the first commit only: its tree carries the first decision.
        const firstTree = fixture.repo.commits.get(branchTip)!.tree;
        const merged = fixture.repo.commit({
          parent: fixture.repo.refs.get("refs/remotes/origin/main")!,
          subject: "Squash",
          files: firstTree,
        });
        // The merge is only on the server, and the base fetch is still throttled:
        // observing the merged PR must refetch before replaying leftovers.
        fixture.repo.remoteTips.set("origin/main", merged);
        fixture.gh.prs[0]!.state = "merged";
        yield* service.testing.publishNow(PROJECT_ID);
        overview = yield* service.getOverview(PROJECT_ID);
        assert.strictEqual(fixture.repo.refs.get("refs/remotes/origin/main"), merged);
        assert.strictEqual(overview.publication.unpublishedOps, 1);
        assert.strictEqual(overview.publication.prNumber, 101);
        assert.strictEqual(fixture.gh.prs.length, 2);
        // Every PR call targets the origin fork, never the upstream remote.
        assert.ok(fixture.gh.prs.every((pr) => pr.repo === "o/f5"));
        assert.ok(fixture.gh.calls.every((call) => call === "bodies" || !call.includes("t3code")));
        assert.ok(fixture.gh.calls.includes(`create o/f5:${overview.publication.branch}`));
        // The merged PR's local branch is deleted.
        assert.isFalse(fixture.repo.refs.has(`refs/heads/${firstBranch}`));
        assert.notStrictEqual(overview.publication.branch, firstBranch);
        const ready = yield* service.listTopics({ projectId: PROJECT_ID, list: "ready" });
        assert.strictEqual(ready.topics[0]!.topic.scope, "API only");
      }),
  );

  it.effect("refuses to record or publish over a base ledger file it cannot parse", () =>
    Effect.gen(function* () {
      const fixture = yield* setup();
      const service = yield* fixture.make();
      yield* service.decide({
        projectId: PROJECT_ID,
        topicIds: ["pr-1"],
        decision: { kind: "port" },
      });
      const base = fixture.repo.refs.get("refs/remotes/origin/main")!;
      const broken = fixture.repo.commit({
        parent: base,
        subject: "Break the ledger",
        files: new Map([["upstream/topics/2026-10.json", "{not json"]]),
      });
      fixture.repo.refs.set("refs/remotes/origin/main", broken);
      const refused = yield* service
        .decide({ projectId: PROJECT_ID, topicIds: ["pr-1"], decision: { kind: "watch" } })
        .pipe(Effect.flip);
      assert.strictEqual(refused.code, "unavailable");
      assert.include(refused.message, "upstream/topics/2026-10.json");
      yield* service.testing.publishNow(PROJECT_ID);
      const publication = (yield* service.getOverview(PROJECT_ID)).publication;
      assert.strictEqual(publication.pausedReason, "conflict");
      assert.include(publication.lastError ?? "", "upstream/topics/2026-10.json");
      assert.isFalse(fixture.repo.calls.some((call) => call.startsWith("push")));
      assert.deepStrictEqual(fixture.gh.prs, []);
    }),
  );

  it.effect("pauses on a closed PR until republish, and on push failures until retry", () =>
    Effect.gen(function* () {
      const fixture = yield* setup();
      const service = yield* fixture.make();
      yield* service.decide({
        projectId: PROJECT_ID,
        topicIds: ["pr-1"],
        decision: { kind: "port" },
      });
      yield* service.testing.publishNow(PROJECT_ID);
      fixture.gh.prs[0]!.state = "closed";
      yield* service.testing.publishNow(PROJECT_ID);
      assert.strictEqual(
        (yield* service.getOverview(PROJECT_ID)).publication.pausedReason,
        "closed-pr",
      );
      yield* service.decide({
        projectId: PROJECT_ID,
        topicIds: ["pr-1"],
        decision: { kind: "watch" },
      });
      yield* service.testing.publishNow(PROJECT_ID);
      assert.strictEqual(
        (yield* service.getOverview(PROJECT_ID)).publication.pausedReason,
        "closed-pr",
      );
      fixture.repo.pushFailure = "Permission denied (publickey).";
      yield* service.resolvePublication({ projectId: PROJECT_ID, action: "republish" });
      let publication = (yield* service.getOverview(PROJECT_ID)).publication;
      assert.strictEqual(publication.pausedReason, null);
      assert.strictEqual(publication.lastError, "Permission denied (publickey).");
      for (let attempt = 0; attempt < 3; attempt += 1)
        yield* service.testing.publishNow(PROJECT_ID);
      publication = (yield* service.getOverview(PROJECT_ID)).publication;
      assert.strictEqual(publication.pausedReason, "auth");
      fixture.repo.pushFailure = null;
      yield* service.resolvePublication({ projectId: PROJECT_ID, action: "retry" });
      publication = (yield* service.getOverview(PROJECT_ID)).publication;
      assert.strictEqual(publication.pausedReason, null);
      assert.strictEqual(publication.prNumber, 101);

      // Transient push and GitHub failures keep retrying instead of pausing.
      yield* service.decide({
        projectId: PROJECT_ID,
        topicIds: ["pr-1"],
        decision: { kind: "port" },
      });
      fixture.repo.pushFailure = "ssh: connect to host github.com port 22: Operation timed out";
      for (let attempt = 0; attempt < 5; attempt += 1)
        yield* service.testing.publishNow(PROJECT_ID);
      publication = (yield* service.getOverview(PROJECT_ID)).publication;
      assert.strictEqual(publication.pausedReason, null);
      assert.match(publication.lastError ?? "", /timed out/u);
      fixture.repo.pushFailure = null;
      fixture.gh.failure = new UpstreamGitHubError({
        operation: "pull request lookup",
        detail: "GitHub pull request lookup failed (502).",
        transient: true,
      });
      yield* service.resolvePublication({ projectId: PROJECT_ID, action: "retry" });
      publication = (yield* service.getOverview(PROJECT_ID)).publication;
      assert.strictEqual(publication.pausedReason, null);
      assert.strictEqual(publication.lastError, "GitHub pull request lookup failed (502).");

      // Discard closes the open ledger PR, and refuses while it cannot.
      fixture.gh.failure = new UpstreamGitHubError({
        operation: "pull request close",
        detail: "GitHub pull request close failed (403).",
        transient: false,
      });
      const refused = yield* service
        .resolvePublication({ projectId: PROJECT_ID, action: "discard" })
        .pipe(Effect.flip);
      assert.strictEqual(refused.code, "unavailable");
      assert.strictEqual(fixture.gh.prs[1]!.state, "open");
      assert.ok((yield* service.getOverview(PROJECT_ID)).publication.unpublishedOps > 0);
      fixture.gh.failure = null;
      yield* service.resolvePublication({ projectId: PROJECT_ID, action: "discard" });
      assert.strictEqual(fixture.gh.prs[1]!.state, "closed");
      assert.ok(fixture.gh.calls.includes("close 101"));
      const after = yield* service.getOverview(PROJECT_ID);
      assert.strictEqual(after.publication.unpublishedOps, 0);
      assert.strictEqual(after.publication.prNumber, null);
      assert.strictEqual(after.counts.inbox, 1);
    }),
  );

  it.effect(
    "admits ports idempotently, rejects mismatched retries and resumes pending groups",
    () =>
      Effect.gen(function* () {
        const fixture = yield* setup({ count: 2 });
        const service = yield* fixture.make();
        yield* service.run({ projectId: PROJECT_ID, kind: "upstream", triage: "rules-only" });
        yield* service.testing.awaitIdle;
        const ids = (yield* service.listTopics({ projectId: PROJECT_ID, list: "inbox" })).topics
          .map((row) => row.topic.id)
          .filter((id) => id !== "pr-1");
        const notReady = yield* service
          .startPort({
            projectId: PROJECT_ID,
            topicIds: [ids[0]!],
            grouping: "together",
            modelSelection: { instanceId: "claudeAgent", model: "claude-test" } as never,
            runtimeMode: "full-access",
            clientRequestId: "request-0001",
          })
          .pipe(Effect.flip);
        assert.strictEqual(notReady.code, "invalid");
        const marked = yield* service.decide({
          projectId: PROJECT_ID,
          topicIds: ids,
          decision: { kind: "port" },
        });

        const promptOnly = yield* service.getPortPrompt({
          projectId: PROJECT_ID,
          topicIds: [ids[0]!],
        });
        assert.ok(promptOnly.prompt.includes(`Upstream-Topic: ${ids[0]}`));
        assert.strictEqual((yield* service.getOverview(PROJECT_ID)).counts["in-progress"], 0);

        let attempts = 0;
        fixture.host.submitOutcome = (body) => {
          attempts += 1;
          if (attempts === 1) return Effect.fail({ message: "queue busy" });
          if (String(body.submissionId).endsWith(":1"))
            return Effect.succeed({
              submissionId: body.submissionId,
              disposition: "rejected",
              reasonCode: "x",
              detail: "No",
            } as never);
          return Effect.succeed({
            submissionId: body.submissionId,
            disposition: "started",
            sequence: 1,
          } as never);
        };
        const input = {
          projectId: PROJECT_ID,
          topicIds: ids,
          grouping: "separately" as const,
          modelSelection: { instanceId: "claudeAgent", model: "claude-test" } as never,
          runtimeMode: "full-access" as const,
          clientRequestId: "request-0002",
        };
        const first = yield* service.startPort(input);
        assert.deepStrictEqual(
          first.groups.map((group) => group.status),
          ["pending", "rejected"],
        );
        const command = fixture.host.submissions[0]!.command;
        assert.strictEqual(command.bootstrap?.prepareWorktree?.branch, `f5/upstream-${ids[0]}`);
        assert.ok(command.message.text.includes("UPSTREAM-OUTCOME"));
        const retry = yield* service.startPort(input);
        assert.deepStrictEqual(
          retry.groups.map((group) => group.status),
          ["submitted", "rejected"],
        );
        assert.strictEqual(retry.groups[0]!.threadId, first.groups[0]!.threadId);
        const conflict = yield* service
          .startPort({ ...input, runtimeMode: "approval-required" })
          .pipe(Effect.flip);
        assert.strictEqual(conflict.code, "conflict");
        const counts = (yield* service.getOverview(PROJECT_ID)).counts;
        assert.strictEqual(counts["in-progress"], 1);
        assert.strictEqual(counts.ready, 1);
        // The topic with a port thread keeps its decision; the other goes back to the inbox.
        const undone = yield* service.undoDecisions({
          projectId: PROJECT_ID,
          undoToken: marked.undoToken!,
        });
        assert.deepStrictEqual([undone.updated, undone.unchanged], [[ids[1]], [ids[0]]]);
        const tooMany = yield* service
          .startPort({
            ...input,
            topicIds: ["pr-1", ...ids, "pr-2", "pr-3", "pr-4"] as never,
            clientRequestId: "request-0003",
          })
          .pipe(Effect.flip);
        assert.ok(tooMany.code === "invalid" || tooMany.code === "not-found");

        const linked = yield* service.getTopic({ projectId: PROJECT_ID, topicId: ids[0]! });
        assert.strictEqual(linked.row.links.length, 1);
        const sql = yield* SqlClient.SqlClient;
        const linksVersion = () =>
          sql<{
            version: number;
          }>`SELECT links_version AS version FROM upstream_ledger_publication WHERE project_id = ${PROJECT_ID}`.pipe(
            Effect.map((rows) => rows[0]!.version),
          );
        const before = yield* linksVersion();
        const unlink = service.unlinkPort({
          projectId: PROJECT_ID,
          topicId: ids[0]!,
          threadId: first.groups[0]!.threadId,
        });
        yield* unlink;
        assert.strictEqual(yield* linksVersion(), before + 1);
        assert.strictEqual((yield* service.getOverview(PROJECT_ID)).counts["in-progress"], 0);
        const history = (yield* service.getTopic({ projectId: PROJECT_ID, topicId: ids[0]! }))
          .history;
        assert.deepStrictEqual(
          history.slice(-2).map((entry) => [entry.kind, entry.threadId, entry.at !== null]),
          [
            ["port-started", first.groups[0]!.threadId, true],
            ["unlinked", first.groups[0]!.threadId, false],
          ],
        );
        assert.strictEqual((yield* Effect.flip(unlink)).code, "not-found");
      }),
  );

  it.effect("reconciles pending port groups and interrupted scheduled runs at startup", () =>
    Effect.gen(function* () {
      const fixture = yield* setup({ count: 1 });
      const service = yield* fixture.make();
      yield* service.decide({
        projectId: PROJECT_ID,
        topicIds: ["pr-1"],
        decision: { kind: "port" },
      });
      fixture.host.submitOutcome = () => Effect.fail({ message: "server restarting" });
      const result = yield* service.startPort({
        projectId: PROJECT_ID,
        topicIds: ["pr-1"],
        grouping: "together",
        modelSelection: { instanceId: "claudeAgent", model: "claude-test" } as never,
        runtimeMode: "full-access",
        clientRequestId: "request-0004",
      });
      assert.strictEqual(result.groups[0]!.status, "pending");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO upstream_port_runs (run_id, project_id, kind, trigger, occurrence_due_at, triage, started_at, status,
        commit_count, inbox_count, auto_decided_count, remaining_count, llm_calls)
        VALUES ('stale', ${PROJECT_ID}, 'upstream', 'schedule', '2026-10-22T11:00:00.000Z', 'llm', '2026-10-22T11:00:00.000Z', 'running', 0, 0, 0, 0, 0)`;
      yield* sql`INSERT INTO upstream_port_occurrences (project_id, due_at, status, attempts, continuations)
        VALUES (${PROJECT_ID}, '2026-10-22T11:00:00.000Z', 'running', 1, 0)`;
      fixture.host.submitOutcome = (body) =>
        Effect.succeed({ submissionId: body.submissionId, disposition: "queued" } as never);
      const restarted = yield* fixture.make();
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* restarted.start;
        }),
      );
      const groups = yield* sql<{
        readonly status: string;
      }>`SELECT status FROM upstream_port_groups`;
      assert.deepStrictEqual(
        groups.map((row) => row.status),
        ["submitted"],
      );
      const occurrence = yield* sql<{ readonly status: string; readonly attempts: number }>`
        SELECT status, attempts FROM upstream_port_occurrences`;
      assert.deepStrictEqual(
        occurrence.map((row) => [row.status, Number(row.attempts)]),
        [["pending", 1]],
      );
    }),
  );

  it.effect("schedules daily runs, and a manual success satisfies the occurrence", () =>
    Effect.gen(function* () {
      const fixture = yield* setup({ count: 2 });
      const service = yield* fixture.make();
      yield* service.testing.schedulerTick;
      yield* service.testing.awaitIdle;
      assert.strictEqual((yield* service.getOverview(PROJECT_ID)).lastRun, null);
      fixture.host.settings = {
        ...fixture.host.settings,
        upstreamPorts: {
          portConcurrency: 5,
          autoRecordOutcomes: true,
          schedule: { mode: "daily", hour: 0, weekday: 1 },
          triageModelSelection: null,
          portModelSelection: null,
        },
      };
      fixture.host.triage = triageAll(() => ({}));
      yield* service.testing.schedulerTick;
      yield* service.testing.awaitIdle;
      let overview = yield* service.getOverview(PROJECT_ID);
      assert.strictEqual(overview.lastRun?.trigger, "schedule");
      assert.strictEqual(overview.occurrence?.status, "succeeded");
      assert.ok(overview.nextRunAt !== null);
      yield* service.testing.schedulerTick;
      yield* service.testing.awaitIdle;
      overview = yield* service.getOverview(PROJECT_ID);
      assert.strictEqual(overview.lastRun?.trigger, "schedule");
    }),
  );
});
