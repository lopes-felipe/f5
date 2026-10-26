import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  UPSTREAM_LEDGER_SCHEMA_VERSION,
  type UpstreamTopic,
  type UpstreamTriageBatchResult,
} from "@t3tools/contracts";
import {
  digestShas,
  serializeLedgerFiles,
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
        yield* service.decide({ projectId: PROJECT_ID, topicIds: ids, decision: { kind: "port" } });

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
