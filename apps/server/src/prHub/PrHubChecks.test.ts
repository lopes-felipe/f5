import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  PullRequestKey,
  type ForgeCapabilities,
  type ForgePrepareOperationInput,
} from "@t3tools/contracts";
import { GITHUB_FORGE_CAPABILITIES } from "@t3tools/shared/forgeCapabilities";
import { SqlClient } from "effect/unstable/sql";
import { ServerConfig } from "../config.ts";
import { GitHubCliError } from "../git/Errors.ts";
import {
  GITHUB_CLI_LOGS_UNSUPPORTED,
  type GitHubApiRequest,
  type GitHubApiResponse,
} from "../git/githubApi.ts";
import { makeFakeGitHubCli } from "../git/testDoubles.ts";
import Migration102 from "../persistence/Migrations/102_ForgeAccounts.ts";
import * as SqliteClient from "../persistence/NodeSqliteClient.ts";
import type { ForgeProvider } from "../sourceControl/ForgeSourceControlProvider.ts";
import { SourceControlProviderError } from "../sourceControl/SourceControlProvider.ts";
import { PrHubFederation, type PrHubAccountRuntime } from "./Layers/PrHubFederation.ts";
import { makePrHubExtensions } from "./PrHubExtensions.ts";

const key = PullRequestKey.makeUnsafe("github:github.example/team/repo#7");
const account = {
  id: "account-1",
  provider: "github" as const,
  host: "github.example",
  login: "alice",
  viewerId: "42",
  generation: "gen-1",
};
const response = (status: number, body: unknown): GitHubApiResponse => ({
  status,
  body,
  graphqlErrors: [],
  links: {},
  etag: null,
  lastModified: null,
  rateLimit: {},
  rateLimitResource: null,
});
const job = (id: number, name: string, conclusion: string | null, slug = "github-actions") => ({
  __typename: "CheckRun",
  databaseId: id,
  name,
  status: conclusion === null ? "IN_PROGRESS" : "COMPLETED",
  conclusion,
  detailsUrl: `https://github.example/team/repo/actions/runs/9/job/${id}`,
  startedAt: "2026-11-14T06:54:26Z",
  completedAt: conclusion === null ? null : "2026-11-14T06:59:44Z",
  isRequired: false,
  checkSuite:
    slug === "github-actions"
      ? { app: { slug }, workflowRun: { databaseId: 9, workflow: { name: "CI" } } }
      : { app: { slug }, workflowRun: null },
});
const checksBody = (nodes: unknown[], headRefOid: string) => ({
  data: {
    repository: {
      pullRequest: {
        headRefOid,
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
                },
              },
            },
          ],
        },
      },
    },
  },
});
const LOG = [
  "﻿2026-11-14T06:58:50.0000000Z ##[group]Run bun run lint",
  "2026-11-14T06:58:51.0000000Z \u001B[31msrc/a.ts: unused variable\u001B[0m",
  "2026-11-14T06:58:53.0000000Z ##[error]Process completed with exit code 1.",
  "",
].join("\r\n");

interface State {
  checks: unknown[];
  /** The head GitHub reports with the checks, and the head the hub tracks (null: untracked). */
  head: string;
  trackedHead: string | null;
  log: GitHubApiResponse | GitHubCliError;
  requests: GitHubApiRequest[];
  /** The failed runs the forge lists, or why it lists none. */
  failedRuns: WorkflowRun[] | SourceControlProviderError;
  /** What the forge answers when asked to restart a run; accepted when absent. */
  rerunAnswers: Record<number, string | SourceControlProviderError>;
  /** The runs the forge was asked to restart, in order. */
  reruns: number[];
  /** A run as the forge reports it now; unchanged since it was listed when absent. */
  runsNow: Record<number, WorkflowRun>;
  detailChecks: Array<{ name: string; status: "failure" | "success" }>;
}
interface WorkflowRun {
  id: number;
  attempt: number;
  completed: boolean;
}
const failedRun = (id: number, attempt = 1): WorkflowRun => ({ id, attempt, completed: true });

interface FixtureOptions {
  readonly github: boolean;
  readonly capabilities?: ForgeCapabilities;
}

const fixture = (options: FixtureOptions) =>
  Effect.gen(function* () {
    yield* Migration102;
    const sql = yield* SqlClient.SqlClient;
    const config = yield* ServerConfig;
    const state: State = {
      checks: [
        job(501, "static", "FAILURE"),
        job(502, "test", null),
        job(503, "deploy preview", "FAILURE", "vercel"),
      ],
      head: "head-1",
      trackedHead: "head-1",
      log: response(200, LOG),
      requests: [],
      failedRuns: [failedRun(11)],
      rerunAnswers: {},
      reruns: [],
      runsNow: {},
      detailChecks: [
        { name: "pipeline", status: "failure" },
        { name: "lint", status: "success" },
      ],
    };
    const github = {
      ...makeFakeGitHubCli().service,
      getCredentialContext: () =>
        Effect.succeed({ host: account.host, viewerId: 42, login: "alice", generation: "a" }),
      request: (input: GitHubApiRequest) => {
        state.requests.push(input);
        if (input.endpoint === "graphql")
          return Effect.succeed(response(200, checksBody(state.checks, state.head)));
        if (input.endpoint.endsWith("/logs"))
          return "_tag" in state.log ? Effect.fail(state.log) : Effect.succeed(state.log);
        return Effect.succeed(response(404, { message: "Not Found" }));
      },
    };
    const provider = {
      forgeCapabilities: options.capabilities ?? GITHUB_FORGE_CAPABILITIES,
      getDetail: () =>
        Effect.succeed({ number: 7, title: "A pull request", headRefOid: "head-1", raw: {} }),
      workflowRuns: {
        listFailed: () =>
          Effect.suspend(() =>
            Array.isArray(state.failedRuns)
              ? Effect.succeed(state.failedRuns)
              : Effect.fail(state.failedRuns),
          ),
        rerunFailedJobs: (input: { runId: number }) =>
          Effect.suspend(() => {
            state.reruns.push(input.runId);
            const answer = state.rerunAnswers[input.runId] ?? null;
            return typeof answer === "string" || answer === null
              ? Effect.succeed(answer)
              : Effect.fail(answer);
          }),
        get: (input: { runId: number }) =>
          Effect.sync(() => state.runsNow[input.runId] ?? failedRun(input.runId)),
      },
    } as unknown as ForgeProvider;
    const hub = {
      getSnapshot: Effect.sync(() => ({
        account: { generation: account.generation },
        pullRequests: state.trackedHead ? [{ key, headRefOid: state.trackedHead }] : [],
        recentlyResolved: [],
      })),
      getDetail: () =>
        Effect.succeed({
          detail: {
            providerDetails: { provider: "gitlab", headRefOid: "head-1" },
            checks: state.detailChecks.map((check) => ({
              ...check,
              description: null,
              url: null,
            })),
            truncatedSections: ["checks"],
          },
          stale: false,
          refreshedAt: "2026-11-14T07:00:00.000Z",
        }),
    } as unknown as PrHubAccountRuntime["hub"];
    const runtime: PrHubAccountRuntime = {
      account,
      hub,
      provider,
      ...(options.github ? { github } : {}),
    };
    const engine = yield* makePrHubExtensions.pipe(
      Effect.provideService(PrHubFederation, {
        hub,
        resolve: () => Effect.succeed(runtime),
        parseUrl: () => Effect.succeed(null),
      }),
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provideService(ServerConfig, config),
    );
    return { state, engine };
  });

function run<A, E>(
  test: (value: Effect.Success<ReturnType<typeof fixture>>) => Effect.Effect<A, E>,
  options: FixtureOptions = { github: true },
) {
  return Effect.scoped(fixture(options).pipe(Effect.flatMap(test))).pipe(
    Effect.provide(
      Layer.mergeAll(
        SqliteClient.layerMemory(),
        ServerConfig.layerTest(process.cwd(), { prefix: "f5-pr-hub-checks-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );
}
const graphqlReads = (state: State) =>
  state.requests.filter((request) => request.endpoint === "graphql").length;
const logReads = (state: State) =>
  state.requests.filter((request) => request.endpoint.endsWith("/logs"));

it.effect("lists the head commit's checks and reuses a recent read until forced", () =>
  run(({ engine, state }) =>
    Effect.gen(function* () {
      const result = yield* engine.getChecks({ key });
      assert.strictEqual(result.headOid, "head-1");
      assert.strictEqual(result.truncated, false);
      assert.deepStrictEqual(
        result.checks.map((check) => [
          check.id,
          check.workflow,
          check.workflowRunId,
          check.status,
          check.logAvailable,
        ]),
        [
          ["501", "CI", "9", "failure", true],
          ["502", "CI", "9", "pending", false],
          ["503", null, null, "failure", false],
        ],
      );
      assert.deepStrictEqual((state.requests[0]?.body as { variables?: unknown })?.variables, {
        owner: "team",
        name: "repo",
        number: 7,
        cursor: null,
      });
      state.checks = [job(501, "static", "SUCCESS")];
      assert.strictEqual((yield* engine.getChecks({ key })).checks.length, 3);
      assert.strictEqual(graphqlReads(state), 1);
      const forced = yield* engine.getChecks({ key, mode: "force" });
      assert.deepStrictEqual(
        forced.checks.map((check) => check.status),
        ["success"],
      );
      assert.strictEqual(graphqlReads(state), 2);
    }),
  ),
);

it.effect("returns the part of a job log around its error and reads a finished log once", () =>
  run(({ engine, state }) =>
    Effect.gen(function* () {
      const log = yield* engine.getCheckLog({ key, checkId: "501" });
      assert.deepStrictEqual(log, {
        checkId: "501",
        excerpt: [
          "##[group]Run bun run lint",
          "src/a.ts: unused variable",
          "##[error]Process completed with exit code 1.",
        ].join("\n"),
        startLine: 1,
        totalLines: 3,
        errorLine: 3,
        truncated: false,
      });
      assert.deepStrictEqual(
        logReads(state).map((request) => [request.method, request.endpoint, request.terminalText]),
        [["GET", "repos/team/repo/actions/jobs/501/logs", true]],
      );
      assert.deepStrictEqual(yield* engine.getCheckLog({ key, checkId: "501" }), log);
      assert.strictEqual(logReads(state).length, 1);
    }),
  ),
);

it.effect("says why a log cannot be shown instead of failing", () =>
  run(({ engine, state }) =>
    Effect.gen(function* () {
      const reason = (checkId: string) =>
        engine
          .getCheckLog({ key, checkId })
          .pipe(Effect.map((log) => [log.excerpt, log.unavailable]));
      assert.deepStrictEqual(yield* reason("502"), [null, "pending"]);
      assert.deepStrictEqual(yield* reason("503"), [null, "unsupported"]);
      assert.strictEqual(logReads(state).length, 0);
      state.log = response(410, null);
      assert.deepStrictEqual(yield* reason("501"), [null, "expired"]);
      state.log = response(403, { message: "Must have admin rights" });
      assert.deepStrictEqual(yield* reason("501"), [null, "forbidden"]);
      state.log = { ...response(403, null), rateLimit: { remaining: 0 } };
      assert.deepStrictEqual(yield* reason("501"), [null, "failed"]);
      state.log = new GitHubCliError({
        operation: "request",
        kind: "invalid_json",
        detail: "GitHub response was interrupted or truncated.",
      });
      assert.deepStrictEqual(yield* reason("501"), [null, "failed"]);
      state.log = response(200, "");
      assert.deepStrictEqual(yield* reason("501"), [null, "failed"]);
      // None of these was kept, so the log is read again once it can be.
      state.log = response(200, LOG);
      assert.strictEqual((yield* engine.getCheckLog({ key, checkId: "501" })).errorLine, 3);
    }),
  ),
);

it.effect("refuses a check that is not on the pull request's head commit", () =>
  run(({ engine, state }) =>
    Effect.gen(function* () {
      const result = yield* engine.getCheckLog({ key, checkId: "999" }).pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") assert.strictEqual(result.failure.kind, "not_found");
      assert.strictEqual(logReads(state).length, 0);
    }),
  ),
);

it.effect("lists another forge's checks from its detail, without logs", () =>
  run(
    ({ engine, state }) =>
      Effect.gen(function* () {
        const result = yield* engine.getChecks({ key });
        assert.strictEqual(result.headOid, "head-1");
        assert.strictEqual(result.truncated, true);
        assert.deepStrictEqual(
          result.checks.map((check) => [
            check.id,
            check.status,
            check.workflow,
            check.logAvailable,
          ]),
          [
            ["check:0:pipeline", "failure", null, false],
            ["check:1:lint", "success", null, false],
          ],
        );
        const log = yield* engine.getCheckLog({ key, checkId: "check:0:pipeline" });
        assert.strictEqual(log.unavailable, "unsupported");
        assert.strictEqual(state.requests.length, 0);
      }),
    { github: false },
  ),
);

const rerun = (operationId: string): ForgePrepareOperationInput => ({
  key,
  operationId,
  accountGeneration: account.generation,
  expectedHeadOid: "head-1",
  payload: { kind: "action", action: "rerun-failed-checks" },
});
const identify = (input: ForgePrepareOperationInput) => ({
  key: input.key,
  operationId: input.operationId,
  accountGeneration: input.accountGeneration,
});

it.effect("re-runs failed checks through a prepared operation at the prepared head", () =>
  run(({ engine, state }) =>
    Effect.gen(function* () {
      const input = rerun("rerun-1");
      state.failedRuns = [failedRun(11), failedRun(13)];
      assert.strictEqual((yield* engine.prepareOperation(input)).status, "prepared");
      assert.strictEqual(state.reruns.length, 0);
      const done = yield* engine.submitOperation(identify(input));
      assert.strictEqual(done.status, "succeeded");
      assert.strictEqual(done.warning, undefined);
      assert.deepStrictEqual(state.reruns, [11, 13]);
      // A second submit of the same operation sends nothing.
      assert.strictEqual((yield* engine.submitOperation(identify(input))).status, "succeeded");
      assert.strictEqual(state.reruns.length, 2);
    }),
  ),
);

const unconfirmed = new SourceControlProviderError({
  provider: "github",
  operation: "forge.request",
  kind: "network",
  detail: "The connection was reset.",
  requestDispatched: true,
});

it.effect("re-runs only the selected failed workflow on the prepared head", () =>
  run(({ engine, state }) =>
    Effect.gen(function* () {
      const input: ForgePrepareOperationInput = {
        ...rerun("rerun-one"),
        payload: { kind: "action", action: "rerun-failed-checks", workflowRunId: 13 },
      };
      state.failedRuns = [failedRun(11), failedRun(13)];
      yield* engine.prepareOperation(input);
      assert.strictEqual((yield* engine.submitOperation(identify(input))).status, "succeeded");
      assert.deepStrictEqual(state.reruns, [13]);
    }),
  ),
);

it.effect("restarts the other runs when GitHub refuses one, and says so", () =>
  run(({ engine, state }) =>
    Effect.gen(function* () {
      state.failedRuns = [failedRun(11), failedRun(12), failedRun(13)];
      state.rerunAnswers = { 12: "GitHub refused to re-run a workflow run (403)." };
      const input = rerun("rerun-refused-one");
      yield* engine.prepareOperation(input);
      const done = yield* engine.submitOperation(identify(input));
      assert.deepStrictEqual(state.reruns, [11, 12, 13]);
      assert.strictEqual(done.status, "succeeded");
      assert.strictEqual(
        done.warning,
        "2 of 3 failed runs were restarted. GitHub refused to re-run a workflow run (403).",
      );
      // Nothing is left pending, so the next action on the pull request can be prepared.
      assert.strictEqual(
        (yield* engine.prepareOperation(rerun("rerun-after-refusal"))).status,
        "prepared",
      );

      // A re-run GitHub refuses outright restarted nothing: it failed, with the reason.
      state.failedRuns = [failedRun(21)];
      state.rerunAnswers = { 21: "GitHub refused to re-run a workflow run (403)." };
      const refused = yield* engine.submitOperation(identify(rerun("rerun-after-refusal")));
      assert.strictEqual(refused.status, "failed");
      assert.strictEqual(refused.error, "GitHub refused to re-run a workflow run (403).");
    }),
  ),
);

it.effect("reports a re-run that was never sent as failed", () =>
  run(({ engine, state }) =>
    Effect.gen(function* () {
      state.failedRuns = new SourceControlProviderError({
        provider: "github",
        operation: "rerun-failed-checks",
        kind: "invalid_response",
        detail: "No failed GitHub Actions run can be re-run at this revision.",
        requestDispatched: false,
      });
      const input = rerun("rerun-unsent");
      yield* engine.prepareOperation(input);
      const result = yield* engine.submitOperation(identify(input));
      assert.strictEqual(result.status, "failed");
      assert.strictEqual(
        result.error,
        "No failed GitHub Actions run can be re-run at this revision.",
      );
    }),
  ),
);

it.effect("recovers an unconfirmed re-run from the runs it asked to restart", () =>
  run(({ engine, state }) =>
    Effect.gen(function* () {
      state.failedRuns = [failedRun(11, 2)];
      state.rerunAnswers = { 11: unconfirmed };
      const input = rerun("rerun-unknown");
      yield* engine.prepareOperation(input);
      assert.strictEqual(
        (yield* engine.submitOperation(identify(input))).status,
        "outcome_unknown",
      );

      // The run is on the attempt it was on: the re-run cannot be confirmed.
      assert.strictEqual(
        (yield* engine.recoverOperation(identify(input))).status,
        "outcome_unknown",
      );

      // The re-run ran and failed again before anyone looked. It was still sent, whatever
      // other failed runs the commit has by now.
      state.runsNow = { 11: failedRun(11, 3) };
      state.failedRuns = [failedRun(11, 3), failedRun(99)];
      const recovered = yield* engine.recoverOperation(identify(input));
      assert.strictEqual(recovered.status, "succeeded");
      assert.strictEqual(recovered.warning, undefined);
      assert.deepStrictEqual(state.reruns, [11]);
    }),
  ),
);

it.effect("recovers a re-run that stopped partway from the runs it reached", () =>
  run(({ engine, state }) =>
    Effect.gen(function* () {
      state.failedRuns = [failedRun(11), failedRun(12), failedRun(13)];
      state.rerunAnswers = { 12: unconfirmed };
      const input = rerun("rerun-partway");
      yield* engine.prepareOperation(input);
      assert.strictEqual(
        (yield* engine.submitOperation(identify(input))).status,
        "outcome_unknown",
      );
      // The third run was never asked for.
      assert.deepStrictEqual(state.reruns, [11, 12]);

      // The first is running again; the second never started. That settles the operation,
      // and names what is left.
      state.runsNow = { 11: { id: 11, attempt: 2, completed: false } };
      const recovered = yield* engine.recoverOperation(identify(input));
      assert.strictEqual(recovered.status, "succeeded");
      assert.strictEqual(
        recovered.warning,
        "1 of 2 failed runs were restarted. Re-run the others if they still fail.",
      );
      assert.strictEqual(
        (yield* engine.prepareOperation(rerun("rerun-after-partway"))).status,
        "prepared",
      );
    }),
  ),
);

it.effect("does not serve one commit's checks as the next commit's", () =>
  run(({ engine, state }) =>
    Effect.gen(function* () {
      assert.strictEqual((yield* engine.getChecks({ key })).headOid, "head-1");
      assert.strictEqual(graphqlReads(state), 1);

      // A push from outside: the hub tracks the new head inside the cache's lifetime.
      state.head = "head-2";
      state.trackedHead = "head-2";
      state.checks = [job(601, "static", null)];
      const next = yield* engine.getChecks({ key });
      assert.strictEqual(next.headOid, "head-2");
      assert.deepStrictEqual(
        next.checks.map((check) => check.id),
        ["601"],
      );
      assert.strictEqual(graphqlReads(state), 2);
      // The new commit's checks are reused as before.
      yield* engine.getChecks({ key });
      assert.strictEqual(graphqlReads(state), 2);

      // A pull request the hub does not track has no head to compare with.
      state.trackedHead = null;
      yield* engine.getChecks({ key });
      assert.strictEqual(graphqlReads(state), 2);
    }),
  ),
);

it.effect("reads a second job's log without reading the checks again", () =>
  run(({ engine, state }) =>
    Effect.gen(function* () {
      state.checks = [job(501, "static", "FAILURE"), job(504, "unit", "FAILURE")];
      yield* engine.getCheckLog({ key, checkId: "501" });
      assert.strictEqual(graphqlReads(state), 1);
      // The cached checks list cannot be used any more (the head moved), but the job is
      // still known to be this pull request's, so only its log is fetched.
      const reads = graphqlReads(state);
      state.checks = [];
      state.head = "head-2";
      state.trackedHead = "head-2";
      assert.strictEqual((yield* engine.getCheckLog({ key, checkId: "504" })).errorLine, 3);
      assert.strictEqual(graphqlReads(state), reads);
      assert.strictEqual(logReads(state).length, 2);
    }),
  ),
);

it.effect("says when the GitHub CLI is too old to print a log", () =>
  run(({ engine, state }) =>
    Effect.gen(function* () {
      state.log = new GitHubCliError({
        operation: "request",
        kind: "generic",
        detail: GITHUB_CLI_LOGS_UNSUPPORTED,
      });
      assert.strictEqual(
        (yield* engine.getCheckLog({ key, checkId: "501" })).unavailable,
        "client_outdated",
      );
    }),
  ),
);

for (const capabilities of [
  { ...GITHUB_FORGE_CAPABILITIES, checks: { logs: true, rerun: false } },
  {
    ...GITHUB_FORGE_CAPABILITIES,
    actions: GITHUB_FORGE_CAPABILITIES.actions.filter((action) => action !== "rerun-failed-checks"),
  },
])
  it.effect("does not prepare a re-run the forge does not advertise", () =>
    run(
      ({ engine, state }) =>
        Effect.gen(function* () {
          const result = yield* engine
            .prepareOperation(rerun("rerun-unsupported"))
            .pipe(Effect.result);
          assert.strictEqual(result._tag, "Failure");
          if (result._tag === "Failure") assert.strictEqual(result.failure.kind, "unsupported");
          assert.strictEqual(state.reruns.length, 0);
        }),
      { github: true, capabilities },
    ),
  );
