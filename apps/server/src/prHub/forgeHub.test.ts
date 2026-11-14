import { it, assert } from "@effect/vitest";
import { Effect, Stream } from "effect";
import {
  DEFAULT_SERVER_SETTINGS,
  PullRequestKey,
  PrHubDetailResult,
  PrHubSnapshot,
  type ForgeAccount,
} from "@t3tools/contracts";
import * as SqliteClient from "../persistence/NodeSqliteClient.ts";
import Migration102 from "../persistence/Migrations/102_ForgeAccounts.ts";
import { makeForgeSourceControlProvider } from "../sourceControl/ForgeSourceControlProvider.ts";
import { ServerSettingsService, type ServerSettingsShape } from "../serverSettings.ts";
import { makeForgePrHubService } from "./forgeHub.ts";
import { ForgeAccounts, type ForgeAccountsShape } from "../sourceControl/accountRouting.ts";
import { Schema } from "effect";
import { evaluatePullRequestWatch } from "../orchestration/pullRequestWatch.ts";

const settings: ServerSettingsShape = {
  start: Effect.void,
  ready: Effect.void,
  getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
  updateSettings: () => Effect.succeed(DEFAULT_SERVER_SETTINGS),
  migrateClientSetting: () => Effect.die("unused"),
  streamChanges: Stream.empty,
  subscribeChanges: Effect.succeed(Stream.empty),
};
const account: ForgeAccount = {
  id: "gl-alice",
  provider: "gitlab",
  host: "gitlab.example.com",
  login: "alice",
  viewerId: "uuid",
  generation: "generation-1",
};
const routedAccounts = (account: ForgeAccount, repository: string): ForgeAccountsShape => {
  const unused = () => Effect.die("unused account operation");
  return {
    listAccounts: () => Effect.succeed([account]),
    listRouting: () =>
      Effect.succeed([
        {
          provider: account.provider,
          host: account.host,
          repository,
          accountId: account.id,
        },
      ]),
    route: () => Effect.succeed(account),
    removeAccount: unused,
    saveAccount: unused,
    getToken: unused,
    removeRouting: unused,
    setRouting: unused,
    resolveAccount: unused,
  };
};
const detail = {
  iid: 7,
  id: 70,
  title: "Native change",
  description: "Native body",
  web_url: "https://gitlab.example.com/group/repo/-/merge_requests/7",
  source_branch: "topic",
  target_branch: "main",
  sha: "head",
  diff_refs: { head_sha: "head", base_sha: "merge-base", start_sha: "base-head" },
  author: { username: "alice" },
  state: "opened",
  head_pipeline: { status: "failed" },
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
};

it.layer(SqliteClient.layerMemory())("native forge hub", (it) => {
  it.effect(
    "refreshes discovered Forgejo checks on every poll and passes required checks through to watches",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* Migration102;
          const forgejo: ForgeAccount = {
            ...account,
            id: "forgejo-discovery",
            provider: "forgejo",
            host: "forgejo.example.com",
          };
          let status = "pending";
          let head = "first";
          let checkReads = 0;
          let failChecks = false;
          const pull = () => ({
            number: 7,
            title: "Forgejo checks",
            state: "open",
            head: { sha: head, ref: "topic" },
            base: { ref: "main" },
            html_url: "https://forgejo.example.com/group/repo/pulls/7",
          });
          const provider = makeForgeSourceControlProvider({
            kind: "forgejo",
            resolveAccount: () =>
              Effect.succeed({
                kind: "forgejo",
                host: forgejo.host,
                login: forgejo.login,
                repository: "group/repo",
                token: "secret",
              }),
            fetch: (async (input) => {
              const url = new URL(String(input));
              if (url.pathname.endsWith("/pulls")) return Response.json([pull()]);
              if (url.pathname.includes("/branches/"))
                return Response.json({
                  enable_status_check: true,
                  status_check_contexts: ["ci/*"],
                });
              if (url.pathname.includes("/statuses/")) {
                checkReads++;
                if (failChecks) return new Response(null, { status: 503 });
                return Response.json(
                  url.searchParams.get("page") === "1"
                    ? [
                        { context: "ci/build", status },
                        { context: "optional", status: "failure" },
                      ]
                    : [],
                );
              }
              return Response.json(pull());
            }) as typeof fetch,
          });
          const hub = yield* makeForgePrHubService(forgejo, provider).pipe(
            Effect.provideService(ServerSettingsService, settings),
            Effect.provideService(ForgeAccounts, routedAccounts(forgejo, "group/repo")),
          );
          const first = (yield* hub.refreshNow({ mode: "force" })).pullRequests[0]!;
          assert.equal(first.checkRollup, "pending");
          status = "success";
          const second = (yield* hub.refreshNow({ mode: "force" })).pullRequests[0]!;
          assert.equal(second.checkRollup, "success");
          assert.equal(checkReads, 4);
          const detail = (yield* hub.getDetail({ key: second.key })).detail;
          const watch = evaluatePullRequestWatch(
            {
              startedAt: "2026-11-14T00:00:00Z",
              headSha: head,
              failedChecks: ["optional"],
              passed: false,
              passedChecks: [],
              remarkIds: [],
              remarksThrough: "2026-11-14T00:00:00Z",
              conflicting: false,
              wakes: 0,
            },
            {
              checks: detail.checks,
              headSha: detail.providerDetails.headRefOid,
              mergeability: detail.mergeable,
              viewer: "alice",
              author: null,
            },
            [],
          );
          assert.deepEqual(watch.changes, [{ kind: "checks-passed", count: 1, required: true }]);
          head = "second";
          status = "failure";
          const moved = (yield* hub.refreshNow({ mode: "force" })).pullRequests[0]!;
          assert.equal(moved.headRefOid, head);
          assert.equal(moved.checkRollup, "failure");
          failChecks = true;
          const incomplete = (yield* hub.refreshNow({ mode: "force" })).pullRequests[0]!;
          assert.equal(incomplete.checkRollup, "pending");
          const partial = yield* hub.getDetail({ key: incomplete.key });
          assert.deepEqual(partial.detail.checks, []);
          assert.deepEqual(partial.detail.truncatedSections, ["checks"]);
        }),
      ).pipe(Effect.provide(SqliteClient.layerMemory())),
  );
  it.effect("refreshes discovered pipeline checks on every poll and marks partial reads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Migration102;
        let partial = false;
        const provider = makeForgeSourceControlProvider({
          kind: "gitlab",
          resolveAccount: () =>
            Effect.succeed({
              kind: "gitlab",
              host: account.host,
              login: account.login,
              token: "secret",
              repository: "group/repo",
            }),
          fetch: (async (url) => {
            const path = new URL(String(url)).pathname;
            if (path.endsWith("/bridges"))
              return partial
                ? new Response(null, { status: 403 })
                : Response.json([{ name: "Pipeline", downstream_pipeline: { status: "failed" } }]);
            // GitLab list responses omit head_pipeline.
            if (path.endsWith("/merge_requests"))
              return Response.json([{ ...detail, head_pipeline: undefined }]);
            return Response.json({
              ...detail,
              head_pipeline: { id: 31, project_id: 12, status: "success" },
            });
          }) as typeof fetch,
        });
        const unused = () => Effect.die("unused account operation");
        const accounts: ForgeAccountsShape = {
          listAccounts: () => Effect.succeed([account]),
          listRouting: () =>
            Effect.succeed([
              {
                provider: "gitlab",
                host: account.host,
                repository: "group/repo",
                accountId: account.id,
              },
            ]),
          route: () => Effect.succeed(account),
          removeAccount: unused,
          saveAccount: unused,
          getToken: unused,
          removeRouting: unused,
          setRouting: unused,
          resolveAccount: unused,
        };
        const hub = yield* makeForgePrHubService({ ...account, id: "discovery" }, provider).pipe(
          Effect.provideService(ServerSettingsService, settings),
          Effect.provideService(ForgeAccounts, {
            ...accounts,
            listAccounts: () => Effect.succeed([{ ...account, id: "discovery" }]),
            listRouting: () =>
              Effect.succeed([
                {
                  provider: "gitlab",
                  host: account.host,
                  repository: "group/repo",
                  accountId: "discovery",
                },
              ]),
            route: () => Effect.succeed({ ...account, id: "discovery" }),
          }),
        );
        const first = yield* hub.refreshNow({ mode: "force" });
        const pr = first.pullRequests[0]!;
        assert.equal(pr.checkRollup, "failure");
        yield* hub.getDetail({ key: pr.key, mode: "force" });
        const polled = yield* hub.refreshNow({ mode: "force" });
        assert.equal(polled.pullRequests[0]?.checkRollup, "failure");
        const read = yield* hub.getDetail({ key: pr.key });
        assert.deepEqual(
          read.detail.checks.map((check) => check.name),
          ["Pipeline", "Downstream: Pipeline"],
        );
        partial = true;
        const incomplete = yield* hub.getDetail({ key: pr.key, mode: "force" });
        assert.deepEqual(incomplete.detail.truncatedSections, ["checks"]);
        assert.equal((yield* hub.getSnapshot).pullRequests[0]?.checkRollup, "pending");
      }),
    ).pipe(Effect.provide(SqliteClient.layerMemory())),
  );
  it.effect(
    "persists snapshots and native files, isolates generations and rejects foreign hosts",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* Migration102;
          let fail = false,
            calls = 0;
          const provider = makeForgeSourceControlProvider({
            kind: "gitlab",
            resolveAccount: () =>
              Effect.succeed({
                kind: "gitlab",
                host: account.host,
                login: account.login,
                token: "secret",
                repository: "group/repo",
              }),
            fetch: (async (url) => {
              calls++;
              if (fail) return new Response(null, { status: 503 });
              const path = new URL(String(url)).pathname;
              if (path.endsWith("/bridges"))
                return Response.json([
                  {
                    name: "deploy",
                    status: "success",
                    downstream_pipeline: {
                      status: "failed",
                      web_url: "https://gitlab.example.com/fork/-/pipelines/32",
                    },
                  },
                ]);
              if (path.endsWith("/diffs"))
                return Response.json([
                  { old_path: "a.ts", new_path: "a.ts", diff: "@@ -1 +1 @@\n-old\n+new\n+added" },
                ]);
              if (path.includes("/discussions"))
                return Response.json([
                  {
                    id: "discussion",
                    notes: [
                      {
                        id: 1,
                        body: "Explain",
                        author: { username: "bob" },
                        created_at: "2026-01-03T00:00:00Z",
                        position: { new_path: "a.ts", new_line: 2 },
                        resolvable: true,
                        resolved: false,
                      },
                    ],
                  },
                ]);
              return Response.json({
                ...detail,
                head_pipeline: { id: 31, project_id: 12, status: "success" },
              });
            }) as typeof fetch,
          });
          const hub = yield* makeForgePrHubService(account, provider).pipe(
            Effect.provideService(ServerSettingsService, settings),
          );
          const pr = yield* hub.track({
            url: detail.web_url,
            accountGeneration: account.generation,
          });
          assert.equal(pr.checkRollup, "failure");
          assert.equal(pr.reviewFactsComplete, false);
          assert.equal(pr.mergePermission, "unknown");
          Schema.decodeUnknownSync(PrHubSnapshot)(yield* hub.getSnapshot);
          const result = Schema.decodeUnknownSync(PrHubDetailResult)(
            yield* hub.getDetail({ key: pr.key }),
          );
          assert.deepEqual(
            result.detail.checks.map((check) => [check.name, check.status]),
            [
              ["Pipeline", "success"],
              ["Downstream: deploy", "failure"],
            ],
          );
          const files = yield* hub.getFiles({ key: pr.key });
          assert.equal((yield* hub.getSnapshot).pullRequests[0]?.checkRollup, "failure");
          assert.equal(files.files.length, 1);
          assert.equal(files.comparison?.headOid, "head");
          assert.equal(files.comparison?.baseOid, "base-head");
          assert.equal(files.comparison?.mergeBaseOid, "merge-base");
          assert.equal(files.files[0]?.additions, 2);
          assert.equal(files.files[0]?.deletions, 1);
          const threads = yield* hub.getReviewThreads({ key: pr.key });
          assert.equal(threads.threads[0]?.path, "a.ts");
          assert.equal(threads.threads[0]?.isResolved, false);
          const restored = yield* makeForgePrHubService(account, provider).pipe(
            Effect.provideService(ServerSettingsService, settings),
          );
          assert.equal((yield* restored.getSnapshot).pullRequests[0]?.changedFiles, 1);
          const rotated = yield* makeForgePrHubService(
            { ...account, generation: "generation-2" },
            provider,
          ).pipe(Effect.provideService(ServerSettingsService, settings));
          assert.equal((yield* rotated.getSnapshot).pullRequests.length, 0);
          assert.equal((yield* rotated.refreshNow({ mode: "force" })).pullRequests[0]?.key, pr.key);
          assert.equal(
            (yield* hub.getDetail({ key: pr.key, accountGeneration: "stale" }).pipe(Effect.result))
              ._tag,
            "Failure",
          );
          assert.equal(
            (yield* hub
              .track({ url: "https://other.example.com/group/repo/-/merge_requests/7" })
              .pipe(Effect.result))._tag,
            "Failure",
          );
          fail = true;
          const stale = yield* hub.getDetail({ key: pr.key, mode: "force" });
          assert.equal(stale.stale, true);
          const count = calls;
          assert.equal((yield* hub.getDetail({ key: pr.key })).stale, true);
          assert.equal(calls, count);
          const refresh = yield* hub.refreshNow({ mode: "force" });
          assert.equal(refresh.status, "degraded");
          assert.equal(refresh.pullRequests.length, 1);
          const failedCount = calls;
          yield* hub.refreshNow({ mode: "if_stale" });
          assert.equal(calls, failedCount);
        }),
      ),
  );

  it.effect("caches failed optional reads without suppressing an explicit retry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let calls = 0;
        const provider = makeForgeSourceControlProvider({
          kind: "gitlab",
          resolveAccount: () =>
            Effect.succeed({
              kind: "gitlab",
              host: account.host,
              login: account.login,
              token: "secret",
              repository: "group/repo",
            }),
          fetch: (async (_url: string | URL | Request) => {
            calls++;
            return new Response(null, { status: 503 });
          }) as typeof fetch,
        });
        const hub = yield* makeForgePrHubService({ ...account, id: "gl-failed" }, provider).pipe(
          Effect.provideService(ServerSettingsService, settings),
        );
        const prKey = PullRequestKey.makeUnsafe("gitlab:gitlab.example.com/group/repo#7");
        assert.equal((yield* hub.getFiles({ key: prKey }).pipe(Effect.result))._tag, "Failure");
        const count = calls;
        assert.equal((yield* hub.getFiles({ key: prKey }).pipe(Effect.result))._tag, "Failure");
        assert.equal(calls, count);
        yield* hub.getFiles({ key: prKey, mode: "force" }).pipe(Effect.result);
        assert.equal(calls, count + 1);
      }),
    ),
  );
  it.effect(
    "rejects a diff read whose base/head change and pins a deliberate retry to the new revisions",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let detailReads = 0;
          const provider = makeForgeSourceControlProvider({
            kind: "gitlab",
            resolveAccount: () =>
              Effect.succeed({
                kind: "gitlab",
                host: account.host,
                login: account.login,
                token: "secret",
                repository: "group/repo",
              }),
            fetch: (async (url: string | URL | Request) => {
              if (new URL(String(url)).pathname.endsWith("/diffs"))
                return Response.json([
                  { new_path: "a.ts", old_path: "a.ts", diff: "@@ -1 +1 @@\n-old\n+new" },
                ]);
              const head = ++detailReads >= 3 ? "new-head" : "head";
              return Response.json({
                ...detail,
                sha: head,
                diff_refs: { head_sha: head, base_sha: "merge-base", start_sha: "base-head" },
              });
            }) as unknown as typeof fetch,
          });
          const hub = yield* makeForgePrHubService({ ...account, id: "race" }, provider).pipe(
            Effect.provideService(ServerSettingsService, settings),
          );
          const pr = yield* hub.track({ url: detail.web_url });
          assert.equal((yield* hub.getFiles({ key: pr.key }).pipe(Effect.result))._tag, "Failure");
          const retry = yield* hub.getFiles({ key: pr.key, mode: "force" });
          assert.equal(retry.comparison?.headOid, "new-head");
          assert.equal((yield* hub.getSnapshot).pullRequests[0]?.headRefOid, "new-head");
        }),
      ),
  );
});
