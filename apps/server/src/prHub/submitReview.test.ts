import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { PullRequestKey } from "@t3tools/contracts";
import * as SqliteClient from "../persistence/NodeSqliteClient.ts";
import Migration083 from "../persistence/Migrations/083_PrHubReviewDrafts.ts";
import Migration084 from "../persistence/Migrations/084_PrHubOperations.ts";
import { savePrHubReviewDraft, readPrHubReviewDraft } from "./reviewDrafts.ts";
import {
  prepareReviewOperation,
  readReviewOperation,
  transitionReviewOperation,
} from "./reviewOperations.ts";
import {
  submitPreparedReview,
  linkReviewSubmission,
  reconcileReviewSubmission,
  type ReviewSubmissionDependencies,
} from "./submitReview.ts";
import { SourceControlProviderError } from "../sourceControl/SourceControlProvider.ts";
import type { GitHubApiResponse } from "../git/githubApi.ts";

function response(body: unknown): GitHubApiResponse {
  return {
    status: 200,
    body,
    links: {},
    graphqlErrors: [],
    etag: null,
    lastModified: null,
    rateLimit: { limit: 5000, remaining: 100, resetAt: null },
    rateLimitResource: "core",
  };
}
const setup = (number: number) =>
  Effect.gen(function* () {
    yield* Migration083;
    yield* Migration084;
    const owner = {
      provider: "github",
      host: "github.com",
      viewerId: "1",
      repo: "org/repo",
      number,
    };
    yield* savePrHubReviewDraft(owner, {
      key: PullRequestKey.makeUnsafe(`github:github.com/org/repo#${number}`),
      expectedVersion: 0,
      comparison: {
        baseRepository: "org/repo",
        baseRef: "main",
        baseOid: "base",
        headRepository: "org/repo",
        headRef: "feature",
        headOid: "head",
        mergeBaseOid: "base",
        mode: "current_pr",
      },
      content: { body: "Review text", comments: [], viewedFiles: [] },
    });
    const operation = yield* prepareReviewOperation(owner, {
      id: `op-${number}`,
      expectedVersion: 1,
      event: "COMMENT",
    });
    const remote = (state: string, actor = 1) => ({
      id: 123,
      user: { id: actor },
      body: operation.payload.body,
      state,
      commit_id: "head",
    });
    return { owner, operation, remote };
  });

it.layer(SqliteClient.layerMemory())("review submission", (it) => {
  it.effect("links only an exactly verified review and never sends a write", () =>
    Effect.gen(function* () {
      const { owner, operation, remote } = yield* setup(5);
      yield* transitionReviewOperation(owner, {
        id: operation.id,
        from: "prepared",
        to: "creating",
      });
      let actor = 2;
      const dependencies: ReviewSubmissionDependencies = {
        verify: () => Effect.void,
        request: (method, endpoint) => {
          assert.equal(method, "GET");
          assert.equal(endpoint, "repos/org/repo/pulls/5/reviews/123");
          return Effect.succeed(response(remote("COMMENTED", actor)));
        },
      };
      assert.equal(
        (yield* Effect.exit(linkReviewSubmission(owner, operation.id, "123", dependencies)))._tag,
        "Failure",
      );
      assert.equal((yield* readPrHubReviewDraft(owner))?.frozen, true);
      actor = 1;
      assert.equal(
        (yield* linkReviewSubmission(owner, operation.id, "123", dependencies)).status,
        "succeeded",
      );
      assert.equal((yield* readPrHubReviewDraft(owner))?.frozen, false);
    }),
  );

  it.effect("does not recreate a review when persisting the accepted remote ID fails", () =>
    Effect.gen(function* () {
      const { owner, operation, remote } = yield* setup(4);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TRIGGER fail_review_id BEFORE UPDATE ON pr_hub_operations
      WHEN NEW.operation_id = 'op-4' AND NEW.status = 'created'
      BEGIN SELECT RAISE(ABORT, 'injected persistence failure'); END`;
      let writes = 0;
      const dependencies: ReviewSubmissionDependencies = {
        verify: () => Effect.void,
        request: (method) => {
          if (method === "POST") {
            writes++;
            return Effect.succeed(response(remote("PENDING")));
          }
          return Effect.succeed(response(writes ? [remote("PENDING")] : []));
        },
      };
      assert.equal(
        (yield* Effect.exit(submitPreparedReview(owner, operation.id, dependencies)))._tag,
        "Failure",
      );
      assert.equal((yield* readReviewOperation(owner, operation.id))?.status, "creating");
      yield* submitPreparedReview(owner, operation.id, dependencies);
      assert.equal(writes, 1);
      assert.equal((yield* readPrHubReviewDraft(owner))?.frozen, true);
      yield* sql`DROP TRIGGER fail_review_id`;
    }),
  );
  it.effect(
    "persists the remote ID before submitting and never sends a successful operation twice",
    () =>
      Effect.gen(function* () {
        const { owner, operation, remote } = yield* setup(1);
        const sql = yield* SqlClient.SqlClient;
        const writes: unknown[] = [];
        const dependencies: ReviewSubmissionDependencies = {
          verify: () => Effect.void,
          request: (method, endpoint, body) =>
            Effect.gen(function* () {
              if (method === "GET")
                return response(endpoint.endsWith("/123") ? remote("PENDING") : []);
              writes.push(body);
              if (endpoint.endsWith("/events")) {
                assert.equal((yield* readReviewOperation(owner, operation.id))?.remoteId, "123");
                return response(remote("COMMENTED"));
              }
              assert.equal((yield* readReviewOperation(owner, operation.id))?.status, "creating");
              assert.equal((body as Record<string, unknown>).event, undefined);
              return response(remote("PENDING"));
            }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie),
        };
        assert.equal(
          (yield* submitPreparedReview(owner, operation.id, dependencies)).status,
          "succeeded",
        );
        assert.equal(
          (yield* submitPreparedReview(owner, operation.id, dependencies)).status,
          "succeeded",
        );
        assert.equal(writes.length, 2);
        assert.equal((yield* readPrHubReviewDraft(owner))?.frozen, false);
      }),
  );
  it.effect("holds a lost creation response and reconciles only the exact actor and marker", () =>
    Effect.gen(function* () {
      const { owner, operation, remote } = yield* setup(2);
      let writes = 0;
      let visible: unknown[] = [];
      const dependencies: ReviewSubmissionDependencies = {
        verify: () => Effect.void,
        request: (method) => {
          if (method === "GET") return Effect.succeed(response(visible));
          writes++;
          return Effect.fail(
            new SourceControlProviderError({
              provider: "github",
              operation: "request",
              kind: "timeout",
              detail: "Response lost",
            }),
          );
        },
      };
      assert.equal(
        (yield* submitPreparedReview(owner, operation.id, dependencies)).status,
        "outcome_unknown",
      );
      visible = [remote("COMMENTED", 2)];
      assert.equal(
        (yield* submitPreparedReview(owner, operation.id, dependencies)).status,
        "outcome_unknown",
      );
      assert.equal(writes, 1);
      assert.equal((yield* readPrHubReviewDraft(owner))?.frozen, true);
      visible = [remote("COMMENTED")];
      assert.equal(
        (yield* reconcileReviewSubmission(owner, operation.id, dependencies)).status,
        "succeeded",
      );
      assert.equal(writes, 1);
    }),
  );
  it.effect("blocks an existing pending review without creating another", () =>
    Effect.gen(function* () {
      const { owner, operation, remote } = yield* setup(3);
      let writes = 0;
      const dependencies: ReviewSubmissionDependencies = {
        verify: () => Effect.void,
        request: (method) => {
          if (method === "POST") writes++;
          return Effect.succeed(response([remote("PENDING")]));
        },
      };
      assert.equal(
        (yield* Effect.exit(submitPreparedReview(owner, operation.id, dependencies)))._tag,
        "Failure",
      );
      assert.equal(writes, 0);
      assert.equal((yield* readReviewOperation(owner, operation.id))?.status, "prepared");
    }),
  );
});
