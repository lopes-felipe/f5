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
import { Schema } from "effect";

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
              return Response.json(detail);
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
          Schema.decodeUnknownSync(PrHubDetailResult)(yield* hub.getDetail({ key: pr.key }));
          const files = yield* hub.getFiles({ key: pr.key });
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
