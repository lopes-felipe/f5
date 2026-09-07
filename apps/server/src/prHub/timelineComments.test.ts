import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqliteClient from "../persistence/NodeSqliteClient.ts";
import Migration084 from "../persistence/Migrations/084_PrHubOperations.ts";
import Migration090 from "../persistence/Migrations/090_PrHubIndependentOperations.ts";
import {
  prepareCommentOperation,
  submitCommentOperation,
  reconcileCommentOperation,
  recoverCommentOperation,
} from "./timelineComments.ts";
import type { GitHubApiResponse } from "../git/githubApi.ts";
import type { ReviewSubmissionDependencies } from "./submitReview.ts";
import { SourceControlProviderError } from "../sourceControl/SourceControlProvider.ts";
const response = (body: unknown, status = 200): GitHubApiResponse => ({
  body,
  status,
  links: {},
  graphqlErrors: [],
  etag: null,
  lastModified: null,
  rateLimit: { limit: 5000, remaining: 100, resetAt: null },
  rateLimitResource: "core",
});
it.layer(SqliteClient.layerMemory())("timeline comment operations", (it) => {
  it.effect("keeps a rate-limited comment prepared and retries only on explicit submission", () =>
    Effect.gen(function* () {
      yield* Migration084;
      yield* Migration090;
      const owner = {
        provider: "github",
        host: "github.com",
        viewerId: "1",
        repo: "org/repo",
        number: 2,
      };
      const operation = yield* prepareCommentOperation(owner, { id: "limited", body: "Keep me" });
      let calls = 0;
      const input = { id: operation.id, payloadHash: operation.payloadHash };
      const limited = yield* submitCommentOperation(
        owner,
        input,
        () => {
          calls++;
          return Effect.succeed({ ...response({}, 403), rateLimit: { retryAfterSeconds: 45 } });
        },
        Effect.void,
      );
      assert.equal(limited.status, "prepared");
      assert.ok(limited.errorMessage?.includes("45"));
      assert.equal(calls, 1);
      const result = yield* submitCommentOperation(
        owner,
        input,
        () => {
          calls++;
          return Effect.succeed(
            response({ id: 42, user: { id: 1 }, body: operation.payload.markedBody }, 201),
          );
        },
        Effect.void,
      );
      assert.equal(result.status, "succeeded");
      assert.equal(calls, 2);
    }),
  );
  it.effect(
    "retains unknown acceptance, never resends and reconciles only the exact actor/body",
    () =>
      Effect.gen(function* () {
        yield* Migration084;
        yield* Migration090;
        const owner = {
          provider: "github",
          host: "github.com",
          viewerId: "1",
          repo: "org/repo",
          number: 12,
        };
        const operation = yield* prepareCommentOperation(owner, {
          id: "comment",
          body: "A timeline comment",
        });
        const input = { id: operation.id, payloadHash: operation.payloadHash };
        let writes = 0;
        let comments: unknown[] = [];
        const request: ReviewSubmissionDependencies["request"] = (method, endpoint, body) => {
          assert.equal(endpoint, "repos/org/repo/issues/12/comments");
          if (method === "GET") return Effect.succeed(response(comments));
          writes++;
          assert.deepStrictEqual(body, { body: operation.payload.markedBody });
          return Effect.fail(
            new SourceControlProviderError({
              provider: "github",
              operation: "test",
              kind: "generic",
              detail: "lost response",
            }),
          );
        };
        assert.equal(
          (yield* submitCommentOperation(
            owner,
            { ...input, payloadHash: "wrong" },
            request,
            Effect.void,
          ).pipe(Effect.exit))._tag,
          "Failure",
        );
        assert.equal(writes, 0);
        assert.equal(
          (yield* submitCommentOperation(owner, input, request, Effect.void)).status,
          "outcome_unknown",
        );
        assert.equal(
          (yield* submitCommentOperation(owner, input, request, Effect.void)).status,
          "outcome_unknown",
        );
        assert.equal(writes, 1);
        comments = [
          { id: 22, user: { id: 2 }, body: operation.payload.markedBody },
          { id: 23, user: { id: 1 }, body: "A timeline comment" },
        ];
        assert.equal(
          (yield* reconcileCommentOperation(owner, request, operation.id))?.status,
          "outcome_unknown",
        );
        comments.push({ id: 24, user: { id: 1 }, body: operation.payload.markedBody });
        assert.equal(
          (yield* reconcileCommentOperation(owner, request, operation.id))?.remoteId,
          "24",
        );
        assert.equal(
          (yield* submitCommentOperation(owner, input, request, Effect.void)).status,
          "succeeded",
        );
        assert.equal(writes, 1);
        const next = yield* prepareCommentOperation(owner, {
          id: "cancel",
          body: "Keep this text",
        });
        const cancelled = yield* recoverCommentOperation(
          owner,
          { id: next.id, payloadHash: next.payloadHash, action: "cancel" },
          request,
        );
        assert.equal(cancelled.status, "failed_before_send");
        assert.equal(cancelled.payload.body, "Keep this text");
      }),
  );
  it.effect("records proven acceptance even when a reconcile lands mid-flight", () =>
    Effect.gen(function* () {
      yield* Migration084;
      yield* Migration090;
      const owner = {
        provider: "github",
        host: "github.com",
        viewerId: "1",
        repo: "org/repo",
        number: 7,
      };
      const operation = yield* prepareCommentOperation(owner, {
        id: "raced",
        body: "Posted exactly once",
      });
      const sql = yield* SqlClient.SqlClient;
      const comments: unknown[] = [];
      let writes = 0;
      let raced = false;
      // Reconcile-on-read is polled by the UI and moves `creating` to `outcome_unknown`.
      // Drive it from inside the POST so it lands after the send is claimed but before
      // the outcome is recorded - the exact interleaving that used to lose the result.
      const request: ReviewSubmissionDependencies["request"] = (method, endpoint, body) => {
        assert.equal(endpoint, "repos/org/repo/issues/7/comments");
        if (method === "GET") return Effect.succeed(response(comments));
        return Effect.gen(function* () {
          writes++;
          assert.deepStrictEqual(body, { body: operation.payload.markedBody });
          if (!raced) {
            raced = true;
            const interleaved = yield* reconcileCommentOperation(owner, request, operation.id).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
              Effect.orDie,
            );
            assert.equal(interleaved?.status, "outcome_unknown");
          }
          const created = { id: 77, user: { id: 1 }, body: operation.payload.markedBody };
          comments.push(created);
          return response(created, 201);
        });
      };
      const result = yield* submitCommentOperation(
        owner,
        { id: operation.id, payloadHash: operation.payloadHash },
        request,
        Effect.void,
      );
      assert.equal(result.status, "succeeded");
      assert.equal(result.remoteId, "77");
      assert.equal(writes, 1);
      // The settled operation stays settled: a later reconcile must not reopen it.
      assert.equal(
        (yield* reconcileCommentOperation(owner, request, operation.id))?.status,
        "succeeded",
      );
      assert.equal(writes, 1);
    }),
  );
});
