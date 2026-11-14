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
import type { GitHubApiRequest, GitHubApiResponse } from "../git/githubApi.ts";
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
const checksBody = (nodes: unknown[]) => ({
  data: {
    repository: {
      pullRequest: {
        headRefOid: "head-1",
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
  log: GitHubApiResponse | GitHubCliError;
  runs: unknown;
  requests: GitHubApiRequest[];
  actions: Array<{ action: string; expectedHeadOid: string | undefined }>;
  actionFailure: SourceControlProviderError | null;
  detailChecks: Array<{ name: string; status: "failure" | "success" }>;
}

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
      log: response(200, LOG),
      runs: { total_count: 1, workflow_runs: [] },
      requests: [],
      actions: [],
      actionFailure: null,
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
          return Effect.succeed(response(200, checksBody(state.checks)));
        if (input.endpoint.endsWith("/logs"))
          return "_tag" in state.log ? Effect.fail(state.log) : Effect.succeed(state.log);
        if (input.endpoint.endsWith("/actions/runs"))
          return Effect.succeed(response(200, state.runs));
        return Effect.succeed(response(404, { message: "Not Found" }));
      },
    };
    const provider = {
      forgeCapabilities: options.capabilities ?? GITHUB_FORGE_CAPABILITIES,
      getDetail: () =>
        Effect.succeed({ number: 7, title: "A pull request", headRefOid: "head-1", raw: {} }),
      performAction: (input: { action: string; expectedHeadOid?: string }) =>
        Effect.suspend(() => {
          state.actions.push({ action: input.action, expectedHeadOid: input.expectedHeadOid });
          return state.actionFailure ? Effect.fail(state.actionFailure) : Effect.succeed(null);
        }),
    } as unknown as ForgeProvider;
    const hub = {
      getSnapshot: Effect.succeed({ account: { generation: account.generation } }),
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
      assert.strictEqual((yield* engine.prepareOperation(input)).status, "prepared");
      assert.strictEqual(state.actions.length, 0);
      assert.strictEqual((yield* engine.submitOperation(identify(input))).status, "succeeded");
      assert.deepStrictEqual(state.actions, [
        { action: "rerun-failed-checks", expectedHeadOid: "head-1" },
      ]);
      // A second submit of the same operation sends nothing.
      assert.strictEqual((yield* engine.submitOperation(identify(input))).status, "succeeded");
      assert.strictEqual(state.actions.length, 1);
    }),
  ),
);

it.effect("reports a re-run that was never sent as failed", () =>
  run(({ engine, state }) =>
    Effect.gen(function* () {
      state.actionFailure = new SourceControlProviderError({
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

it.effect("recovers an unconfirmed re-run from the workflow runs of the prepared head", () =>
  run(({ engine, state }) =>
    Effect.gen(function* () {
      state.actionFailure = new SourceControlProviderError({
        provider: "github",
        operation: "forge.request",
        kind: "network",
        detail: "The connection was reset.",
        requestDispatched: true,
      });
      const input = rerun("rerun-unknown");
      yield* engine.prepareOperation(input);
      assert.strictEqual(
        (yield* engine.submitOperation(identify(input))).status,
        "outcome_unknown",
      );

      // A run that is still failed means the re-run cannot be confirmed.
      state.runs = {
        total_count: 2,
        workflow_runs: [
          { id: 11, status: "completed", conclusion: "failure", head_sha: "head-1" },
          { id: 12, status: "completed", conclusion: "success", head_sha: "head-1" },
        ],
      };
      assert.strictEqual(
        (yield* engine.recoverOperation(identify(input))).status,
        "outcome_unknown",
      );
      const read = state.requests.at(-1);
      assert.strictEqual(read?.endpoint, "repos/team/repo/actions/runs");
      assert.deepStrictEqual(read?.query, { head_sha: "head-1", per_page: 100 });

      state.runs = {
        total_count: 2,
        workflow_runs: [
          { id: 11, status: "in_progress", conclusion: null, head_sha: "head-1" },
          { id: 12, status: "completed", conclusion: "success", head_sha: "head-1" },
        ],
      };
      assert.strictEqual((yield* engine.recoverOperation(identify(input))).status, "succeeded");
      assert.strictEqual(state.actions.length, 1);
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
          assert.strictEqual(state.actions.length, 0);
        }),
      { github: true, capabilities },
    ),
  );
