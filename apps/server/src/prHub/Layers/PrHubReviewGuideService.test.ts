import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Layer, type Scope } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { SqlClient } from "effect/unstable/sql";
import {
  ProviderInstanceId,
  PullRequestKey,
  type PullRequestReviewGuideResult,
} from "@t3tools/contracts";
import * as SqliteClient from "../../persistence/NodeSqliteClient.ts";
import Migration102 from "../../persistence/Migrations/102_ForgeAccounts.ts";
import Migration124 from "../../persistence/Migrations/129_PrHubReviewGuides.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ServerConfig } from "../../config.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { makeFakeTextGeneration } from "../../git/testDoubles.ts";
import { makeForgeSourceControlProvider } from "../../sourceControl/ForgeSourceControlProvider.ts";
import { SourceControlProviderError } from "../../sourceControl/SourceControlProvider.ts";
import { makeForgePrHubService } from "../forgeHub.ts";
import { PrHubFederation } from "./PrHubFederation.ts";
import { makePrHubReviewGuideService } from "./PrHubReviewGuideService.ts";

const key = PullRequestKey.makeUnsafe("gitlab:gitlab.example/team/repo#7");
const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
const output = {
  stops: [
    {
      title: "Contract",
      summary: "Review this boundary",
      attention: null,
      excerpts: [{ path: "a.ts", side: "new", start: 1, end: 999, caption: "Changed line" }],
      files: [],
      notes: [],
      questions: ["Does this preserve the contract?"],
    },
  ],
};

const fixture = Effect.gen(function* () {
  yield* Migration102;
  yield* Migration124;
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* ServerSettingsService;
  const gate = yield* Deferred.make<void>();
  const started = yield* Deferred.make<void>();
  const state = {
    head: "head-1",
    generation: "gen-1",
    accountId: "one",
    delayed: false,
    fail: false,
    calls: 0,
    usedModel: "",
  };
  const account = {
    id: "one",
    generation: "gen-1",
    provider: "gitlab" as const,
    host: "gitlab.example",
    login: "alice",
    viewerId: "42",
  };
  const native = makeForgeSourceControlProvider({
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
        title: "Contract change",
        description: "A change",
        source_branch: "topic",
        target_branch: "main",
        state: "opened",
        sha: state.head,
        diff_refs: { head_sha: state.head, base_sha: "base-1" },
        web_url: "https://gitlab.example/team/repo/-/merge_requests/7",
      })) as unknown as typeof fetch,
  });
  const provider = {
    ...native,
    getFiles: () =>
      Effect.succeed([
        { path: "a.ts", patch, status: "modified", previousPath: null, revision: state.head },
        {
          path: "other.md",
          patch: null,
          status: "modified",
          previousPath: null,
          revision: state.head,
        },
      ]),
    getDiff: () => Effect.succeed(patch),
  };
  const hub = yield* makeForgePrHubService(account, provider);
  const federation = {
    hub,
    parseUrl: () => Effect.succeed(null),
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
            account: { ...account, id: state.accountId, generation: state.generation },
            provider,
            hub,
          }),
  };
  const generator = makeFakeTextGeneration({
    generateStructuredJson: (input) =>
      Effect.gen(function* () {
        state.calls++;
        state.usedModel = input.modelSelection?.model ?? "";
        yield* Deferred.succeed(started, undefined);
        if (state.delayed) yield* Deferred.await(gate);
        if (state.fail) return yield* Effect.die("private-token-must-not-escape");
        return output as typeof input.outputSchema.Type;
      }),
  });
  const create = () =>
    makePrHubReviewGuideService.pipe(
      Effect.provideService(PrHubFederation, federation),
      Effect.provideService(TextGeneration, generator),
    );
  const service = yield* create();
  const input = { key, accountGeneration: "gen-1" };
  const idle = Effect.gen(function* () {
    for (let tries = 0; tries < 100; tries++) {
      const result = yield* service.get({ key });
      if (result.run?._tag !== "Running") return result;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die("Guide did not settle after its deterministic model response");
  });
  return { service, state, settings, sql, gate, started, create, input, idle };
});
function run<A, E>(
  test: (
    value: Effect.Success<typeof fixture>,
  ) => Effect.Effect<
    A,
    E,
    SqlClient.SqlClient | ServerConfig | ServerSettingsService | Scope.Scope
  >,
) {
  return Effect.scoped(fixture.pipe(Effect.flatMap(test))).pipe(
    Effect.provide(
      Layer.mergeAll(
        SqliteClient.layerMemory(),
        ServerSettingsService.layerTest(),
        ServerConfig.layerTest(process.cwd(), { prefix: "f5-review-guides-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );
}

it.effect("saves a normalized guide, includes skim files and uses the configured model", () =>
  run(({ service, idle, settings, state, input }) =>
    Effect.gen(function* () {
      yield* settings.updateSettings({
        reviewGuideModelSelection: {
          instanceId: ProviderInstanceId.makeUnsafe("codex"),
          model: "guide-model",
        },
      });
      yield* service.generate(input);
      const result = yield* idle;
      assert.equal(result.guide?.headSha, "head-1");
      assert.equal(result.guide?.stops[0]?.excerpts[0]?.end, 1);
      assert.equal(result.guide?.stops.at(-1)?.files[0]?.path, "other.md");
      assert.equal(state.usedModel, "guide-model");
    }),
  ),
);

it.effect("coalesces a running PR guide and rejects publication after the head changes", () =>
  run(({ service, state, input, gate, started, idle }) =>
    Effect.gen(function* () {
      state.delayed = true;
      yield* service.generate(input);
      yield* Deferred.await(started);
      yield* service.generate(input);
      assert.equal(state.calls, 1);
      state.head = "head-2";
      yield* Deferred.succeed(gate, undefined);
      const result = yield* idle;
      assert.isNull(result.guide);
      assert.equal(result.run?._tag, "Failed");
    }),
  ),
);

it.effect("keeps the previous guide on failure and does not persist raw model errors", () =>
  run(({ service, state, input, idle, sql }) =>
    Effect.gen(function* () {
      yield* service.generate(input);
      const first = yield* idle;
      state.fail = true;
      yield* service.generate(input);
      const failed = yield* idle;
      assert.deepStrictEqual(failed.guide, first.guide);
      assert.equal(failed.run?._tag, "Failed");
      const rows = yield* sql<{ run_json: string }>`SELECT run_json FROM pr_hub_review_guides`;
      assert.isFalse(rows[0]!.run_json.includes("private-token"));
    }),
  ),
);

it.effect("uses the git text model when no guide override is configured", () =>
  run(({ service, idle, settings, state, input }) =>
    Effect.gen(function* () {
      yield* settings.updateSettings({
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.makeUnsafe("codex"),
          model: "git-text-model",
        },
      });
      yield* service.generate(input);
      assert.isNotNull((yield* idle).guide);
      assert.equal(state.usedModel, "git-text-model");
    }),
  ),
);

it.effect("refuses publication if credentials are replaced during generation", () =>
  run(({ service, state, input, gate, started, idle }) =>
    Effect.gen(function* () {
      state.delayed = true;
      yield* service.generate(input);
      yield* Deferred.await(started);
      state.generation = "gen-2";
      yield* Deferred.succeed(gate, undefined);
      const result = yield* idle;
      assert.isNull(result.guide);
      assert.equal(result.run?._tag, "Failed");
    }),
  ),
);

it.effect("isolates saved guides by account and clears obsolete running jobs on restart", () =>
  run(({ service, state, input, idle, sql, create }) =>
    Effect.gen(function* () {
      yield* service.generate(input);
      const completed = yield* idle;
      state.accountId = "two";
      state.generation = "gen-2";
      assert.isNull((yield* service.get({ key, accountGeneration: "gen-2" })).guide);
      assert.equal((yield* service.get(input).pipe(Effect.flip)).kind, "forbidden");
      state.accountId = "one";
      state.generation = "gen-1";
      const running: PullRequestReviewGuideResult["run"] = {
        _tag: "Running",
        headSha: "head-2",
        startedAt: new Date().toISOString(),
      };
      yield* sql`UPDATE pr_hub_review_guides SET run_json=${JSON.stringify(running)},run_id='dead-process'`;
      const restarted = yield* create();
      const read = yield* restarted.get(input);
      assert.isNull(read.run);
      assert.deepStrictEqual(read.guide, completed.guide);
    }),
  ),
);
