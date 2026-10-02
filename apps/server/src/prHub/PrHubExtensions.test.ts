import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { PullRequestKey, type ForgePrepareOperationInput } from "@t3tools/contracts";
import * as SqliteClient from "../persistence/NodeSqliteClient.ts";
import { SqlClient } from "effect/unstable/sql";
import Migration102 from "../persistence/Migrations/102_ForgeAccounts.ts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { makeForgeSourceControlProvider } from "../sourceControl/ForgeSourceControlProvider.ts";
import { SourceControlProviderError } from "../sourceControl/SourceControlProvider.ts";
import { makeForgePrHubService } from "./forgeHub.ts";
import { PrHubFederation } from "./Layers/PrHubFederation.ts";
import { makePrHubExtensions } from "./PrHubExtensions.ts";

const key = PullRequestKey.makeUnsafe("gitlab:gitlab.example/team/repo#7");
const account = {
  id: "account-1",
  provider: "gitlab" as const,
  host: "gitlab.example",
  login: "alice",
  viewerId: "42",
  generation: "gen-1",
};
const prepared = (
  id: string,
  payload: ForgePrepareOperationInput["payload"] = {
    kind: "comment",
    body: "Keep this exact body",
  },
): ForgePrepareOperationInput => ({
  key,
  operationId: id,
  accountGeneration: account.generation,
  expectedHeadOid: "head-1",
  payload,
});
const identify = (input: ForgePrepareOperationInput) => ({
  key: input.key,
  operationId: input.operationId,
  accountGeneration: input.accountGeneration,
});
type Mode = "success" | "unsent" | "ambiguous";
interface State {
  head: string;
  mode: Mode;
  verdictMode: Mode;
  comments: Readonly<Record<string, unknown>>[];
  writes: string[];
  reviews: { body: string; verdict: string }[];
  delay: boolean;
}
const transportFailure = (mode: Exclude<Mode, "success">) =>
  new SourceControlProviderError({
    provider: "gitlab",
    operation: "fixture.write",
    kind: "network",
    detail: "Fixture provider refused the request.",
    requestDispatched: mode === "ambiguous",
  });
const fixture = Effect.gen(function* () {
  yield* Migration102;
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig;
  const state: State = {
    head: "head-1",
    mode: "success",
    verdictMode: "success",
    comments: [],
    writes: [],
    reviews: [],
    delay: false,
  };
  const native = makeForgeSourceControlProvider({
    kind: "gitlab",
    resolveAccount: () =>
      Effect.succeed({
        kind: "gitlab",
        host: account.host,
        repository: "team/repo",
        login: account.login,
        viewerId: account.viewerId,
        token: "token",
      }),
    fetch: (async () =>
      Response.json({
        iid: 7,
        title: "A native MR",
        source_branch: "topic",
        target_branch: "main",
        state: "opened",
        sha: state.head,
        web_url: "https://gitlab.example/team/repo/-/merge_requests/7",
      })) as unknown as typeof fetch,
  });
  const provider = {
    ...native,
    getComments: () => Effect.succeed(state.comments),
    writeComment: (input: Parameters<typeof native.writeComment>[0]) =>
      Effect.gen(function* () {
        state.writes.push(input.body);
        if (state.delay)
          yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
        if (state.mode !== "success") return yield* transportFailure(state.mode);
        return { id: 1 };
      }),
    submitReview: (input: Parameters<typeof native.submitReview>[0]) =>
      Effect.gen(function* () {
        state.reviews.push({ body: input.body, verdict: input.verdict });
        if (state.verdictMode !== "success") return yield* transportFailure(state.verdictMode);
        return { id: 2 };
      }),
  };
  const hub = yield* makeForgePrHubService(account, provider).pipe(
    Effect.provide(ServerSettingsService.layerTest()),
  );
  const federation = {
    hub,
    resolve: () => Effect.succeed({ account, hub, provider }),
    parseUrl: () =>
      Effect.succeed({
        provider: "gitlab" as const,
        host: account.host,
        repository: "team/repo",
        number: 7,
      }),
  };
  const create = () =>
    makePrHubExtensions.pipe(
      Effect.provideService(PrHubFederation, federation),
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provideService(ServerConfig, config),
    );
  const engine = yield* create();
  return { state, engine, create, sql };
});
function run<A, E>(test: (value: Effect.Success<typeof fixture>) => Effect.Effect<A, E>) {
  return Effect.scoped(fixture.pipe(Effect.flatMap(test))).pipe(
    Effect.provide(
      Layer.mergeAll(
        SqliteClient.layerMemory(),
        ServerConfig.layerTest(process.cwd(), { prefix: "f5-forge-operations-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );
}

it.effect("prepares without HTTP writes, submits once and survives a service restart", () =>
  run(({ engine, state, create }) =>
    Effect.gen(function* () {
      const input = prepared("once");
      const first = yield* engine.prepareOperation(input);
      assert.equal(first.status, "prepared");
      assert.equal(state.writes.length, 0);
      const duplicate = yield* engine.prepareOperation({
        ...input,
        payload: { body: "Keep this exact body", kind: "comment" },
      });
      assert.equal(duplicate.status, "prepared");
      assert.equal((yield* engine.submitOperation(identify(input))).status, "succeeded");
      const restarted = yield* create();
      assert.equal((yield* restarted.submitOperation(identify(input))).status, "succeeded");
      assert.equal((yield* restarted.prepareOperation(input)).status, "succeeded");
      assert.equal(state.writes.length, 1);
      assert.ok(state.writes[0]?.includes("Keep this exact body"));
    }),
  ),
);
it.effect("cancels a prepared operation without dispatching it", () =>
  run(({ engine, state }) =>
    Effect.gen(function* () {
      const input = prepared("cancel-prepared");
      yield* engine.prepareOperation(input);
      assert.equal((yield* engine.cancelOperation(identify(input))).status, "canceled");
      assert.equal((yield* engine.submitOperation(identify(input))).status, "canceled");
      assert.equal(state.writes.length, 0);
    }),
  ),
);
it.effect("does not cancel an operation with an ambiguous dispatched write", () =>
  run(({ engine, state }) =>
    Effect.gen(function* () {
      const input = prepared("cancel-unknown");
      state.mode = "ambiguous";
      yield* engine.prepareOperation(input);
      assert.equal((yield* engine.submitOperation(identify(input))).status, "outcome_unknown");
      assert.equal((yield* engine.cancelOperation(identify(input))).status, "outcome_unknown");
      assert.equal((yield* engine.submitOperation(identify(input))).status, "outcome_unknown");
      assert.equal(state.writes.length, 1);
    }),
  ),
);
it.effect("claims a prepared mutation atomically across concurrent service instances", () =>
  run(({ engine, state, create }) =>
    Effect.gen(function* () {
      const input = prepared("concurrent");
      yield* engine.prepareOperation(input);
      state.delay = true;
      const second = yield* create();
      yield* Effect.all(
        [engine.submitOperation(identify(input)), second.submitOperation(identify(input))],
        { concurrency: 2 },
      );
      assert.equal(state.writes.length, 1);
      assert.equal((yield* engine.getOperation(identify(input)))?.status, "succeeded");
    }),
  ),
);
it.effect("binds an operation ID immutably to its original request", () =>
  run(({ engine, state }) =>
    Effect.gen(function* () {
      const input = prepared("immutable");
      yield* engine.prepareOperation(input);
      const changed = yield* engine
        .prepareOperation({ ...input, payload: { kind: "comment", body: "Mutated body" } })
        .pipe(Effect.result);
      assert.equal(changed._tag, "Failure");
      assert.equal(state.writes.length, 0);
      assert.equal((yield* engine.getOperation(identify(input)))?.payload.kind, "comment");
    }),
  ),
);
it.effect("rejects a changed pinned head before sending", () =>
  run(({ engine, state }) =>
    Effect.gen(function* () {
      const input = prepared("head-changed");
      yield* engine.prepareOperation(input);
      state.head = "head-2";
      assert.equal(
        (yield* engine.submitOperation(identify(input)).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(state.writes.length, 0);
    }),
  ),
);
it.effect(
  "distinguishes definitely unsent failures from ambiguous writes and never resends either",
  () =>
    run(({ engine, state, create }) =>
      Effect.gen(function* () {
        const unsent = prepared("unsent");
        yield* engine.prepareOperation(unsent);
        state.mode = "unsent";
        assert.equal((yield* engine.submitOperation(identify(unsent))).status, "failed");
        assert.equal((yield* engine.submitOperation(identify(unsent))).status, "failed");
        assert.equal(state.writes.length, 1);
        const ambiguous = prepared("ambiguous");
        yield* engine.prepareOperation(ambiguous);
        state.mode = "ambiguous";
        assert.equal(
          (yield* engine.submitOperation(identify(ambiguous))).status,
          "outcome_unknown",
        );
        const restarted = yield* create();
        assert.equal(
          (yield* restarted.submitOperation(identify(ambiguous))).status,
          "outcome_unknown",
        );
        assert.equal(state.writes.length, 2);
        const blocked = yield* restarted
          .prepareOperation(prepared("must-not-bypass-unknown"))
          .pipe(Effect.result);
        assert.equal(blocked._tag, "Failure");
      }),
    ),
);
it.effect("recovers only a marker written by the verified account identity", () =>
  run(({ engine, state }) =>
    Effect.gen(function* () {
      const input = prepared("recover-author");
      yield* engine.prepareOperation(input);
      state.mode = "ambiguous";
      yield* engine.submitOperation(identify(input));
      const body = state.writes[0]!;
      state.comments = [{ id: 1, body, author: { username: "alice", id: 99 } }];
      assert.equal((yield* engine.recoverOperation(identify(input))).status, "outcome_unknown");
      state.comments = [
        {
          id: 1,
          metadata: body,
          body: "An unrelated remark",
          author: { username: "alice", id: 42 },
        },
      ];
      assert.equal((yield* engine.recoverOperation(identify(input))).status, "outcome_unknown");
      state.comments = [
        { id: "discussion", notes: [{ id: 1, body, author: { username: "alice", id: 42 } }] },
      ];
      assert.equal((yield* engine.recoverOperation(identify(input))).status, "succeeded");
      assert.equal(state.writes.length, 1);
    }),
  ),
);
it.effect("records a separate comment and native verdict without dropping the review body", () =>
  run(({ engine, state }) =>
    Effect.gen(function* () {
      const input = prepared("review", {
        kind: "review",
        body: "Approval with an explanation",
        verdict: "approve",
      });
      yield* engine.prepareOperation(input);
      assert.equal((yield* engine.submitOperation(identify(input))).status, "succeeded");
      assert.equal(state.writes.length, 1);
      assert.ok(state.writes[0]?.includes("Approval with an explanation"));
      assert.deepEqual(state.reviews, [{ body: "", verdict: "approve" }]);
    }),
  ),
);
it.effect("recovers an ambiguous comment step and resumes only the unsent verdict", () =>
  run(({ engine, state, create }) =>
    Effect.gen(function* () {
      const input = prepared("review-comment-recovery", {
        kind: "review",
        body: "Preserve my body",
        verdict: "approve",
      });
      yield* engine.prepareOperation(input);
      state.mode = "ambiguous";
      assert.equal((yield* engine.submitOperation(identify(input))).status, "outcome_unknown");
      assert.equal(state.reviews.length, 0);
      state.comments = [{ id: 1, body: state.writes[0], author: { username: "alice", id: 42 } }];
      const restarted = yield* create();
      assert.equal((yield* restarted.recoverOperation(identify(input))).status, "prepared");
      state.mode = "success";
      assert.equal((yield* restarted.submitOperation(identify(input))).status, "succeeded");
      assert.equal(state.writes.length, 1);
      assert.equal(state.reviews.length, 1);
    }),
  ),
);
it.effect("does not infer a dispatched verdict from its explanation comment", () =>
  run(({ engine, state }) =>
    Effect.gen(function* () {
      const input = prepared("review-verdict-unknown", {
        kind: "review",
        body: "Reviewed",
        verdict: "approve",
      });
      yield* engine.prepareOperation(input);
      state.verdictMode = "ambiguous";
      assert.equal((yield* engine.submitOperation(identify(input))).status, "outcome_unknown");
      state.comments = [{ id: 1, body: state.writes[0], author: { username: "alice", id: 42 } }];
      assert.equal((yield* engine.recoverOperation(identify(input))).status, "outcome_unknown");
      yield* engine.submitOperation(identify(input));
      assert.equal(state.writes.length, 1);
      assert.equal(state.reviews.length, 1);
    }),
  ),
);
it.effect("rejects unadvertised operations before preparing or dispatching", () =>
  run(({ engine, state }) =>
    Effect.gen(function* () {
      const input = prepared("unsupported", {
        kind: "review",
        body: "Request changes",
        verdict: "request-changes",
      });
      assert.equal((yield* engine.prepareOperation(input).pipe(Effect.result))._tag, "Failure");
      assert.equal(state.writes.length, 0);
      assert.equal(state.reviews.length, 0);
    }),
  ),
);

it.effect(
  "allows the same reader to inspect and cancel an old credential generation without dispatch",
  () =>
    run(({ engine, state, sql }) =>
      Effect.gen(function* () {
        const input = prepared("rotated-prepared");
        yield* engine.prepareOperation(input);
        yield* sql`UPDATE forge_operations SET payload_json=${JSON.stringify({ ...input, accountGeneration: "old-generation" })} WHERE operation_id=${input.operationId}`;
        assert.equal(
          (yield* engine.getOperation(identify(input)))?.accountGeneration,
          "old-generation",
        );
        assert.equal(
          (yield* engine.submitOperation(identify(input)).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal((yield* engine.cancelOperation(identify(input))).status, "canceled");
        assert.equal(state.writes.length, 0);
      }),
    ),
);
it.effect(
  "recovers an old credential generation using the same verified reader's host evidence",
  () =>
    run(({ engine, state, sql }) =>
      Effect.gen(function* () {
        const input = prepared("rotated-unknown");
        yield* engine.prepareOperation(input);
        state.mode = "ambiguous";
        yield* engine.submitOperation(identify(input));
        yield* sql`UPDATE forge_operations SET payload_json=${JSON.stringify({ ...input, accountGeneration: "old-generation" })} WHERE operation_id=${input.operationId}`;
        state.comments = [{ body: state.writes[0], author: { id: 42, username: "alice" } }];
        assert.equal((yield* engine.recoverOperation(identify(input))).status, "succeeded");
        assert.equal(state.writes.length, 1);
      }),
    ),
);
