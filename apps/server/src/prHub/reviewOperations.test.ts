import Migration086 from "../persistence/Migrations/086_PrHubAbandonedReviews.ts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { PullRequestKey, type PrHubSaveReviewDraftInput } from "@t3tools/contracts";
import * as SqliteClient from "../persistence/NodeSqliteClient.ts";
import Migration083 from "../persistence/Migrations/083_PrHubReviewDrafts.ts";
import Migration084 from "../persistence/Migrations/084_PrHubOperations.ts";
import { readPrHubReviewDraft, savePrHubReviewDraft } from "./reviewDrafts.ts";
import {
  prepareReviewOperation,
  readReviewOperation,
  transitionReviewOperation,
} from "./reviewOperations.ts";

it.layer(SqliteClient.layerMemory())("durable review operations", (it) => {
  it.effect("freezes immutable intent, serializes stages and retains unknown outcomes", () =>
    Effect.gen(function* () {
      yield* Migration083;
      yield* Migration084;
      const owner = {
        provider: "github",
        host: "github.com",
        viewerId: "1",
        repo: "org/repo",
        number: 1,
      };
      const draft: PrHubSaveReviewDraftInput = {
        key: PullRequestKey.makeUnsafe("github:github.com/org/repo#1"),
        expectedVersion: 0,
        comparison: {
          baseRepository: "org/repo",
          baseRef: "main",
          baseOid: "base",
          headRepository: "org/repo",
          headRef: "topic",
          headOid: "head",
          mergeBaseOid: "merge-base",
          mode: "current_pr",
        },
        content: { body: "Please explain this.", comments: [], viewedFiles: [] },
      };
      yield* savePrHubReviewDraft(owner, draft);
      const input = { id: "submission", expectedVersion: 1, event: "COMMENT" as const };
      const prepared = yield* prepareReviewOperation(owner, input);
      assert.equal(prepared.status, "prepared");
      assert.equal(
        prepared.payload.body.includes(`<!-- F5 review ${prepared.correlationNonce} -->`),
        true,
      );
      assert.equal((yield* readPrHubReviewDraft(owner))?.frozen, true);
      assert.deepStrictEqual(yield* prepareReviewOperation(owner, input), prepared);
      assert.equal(
        (yield* savePrHubReviewDraft(owner, { ...draft, expectedVersion: 1 })).status,
        "frozen",
      );
      assert.equal(
        (yield* Effect.exit(prepareReviewOperation(owner, { ...input, id: "second" })))._tag,
        "Failure",
      );
      assert.equal(yield* readReviewOperation({ ...owner, viewerId: "2" }, input.id), null);
      const acquire = () =>
        transitionReviewOperation(owner, { id: input.id, from: "prepared", to: "creating" });
      assert.equal(yield* acquire(), true);
      assert.equal(yield* acquire(), false);
      // Simulate a lost response after the remote creation may have been accepted.
      yield* transitionReviewOperation(owner, {
        id: input.id,
        from: "creating",
        to: "outcome_unknown",
      });
      assert.equal((yield* readReviewOperation(owner, input.id))?.status, "outcome_unknown");
      assert.equal((yield* readPrHubReviewDraft(owner))?.frozen, true);
      assert.equal(
        (yield* Effect.exit(
          transitionReviewOperation(owner, {
            id: input.id,
            from: "outcome_unknown",
            to: "creating",
          }),
        ))._tag,
        "Failure",
      );
      // A separate verified reconciliation can confirm success; it cannot resend.
      yield* transitionReviewOperation(owner, {
        id: input.id,
        from: "outcome_unknown",
        to: "succeeded",
        remoteId: "123",
      });
      assert.equal(
        (yield* readReviewOperation(owner, input.id))?.payloadHash,
        prepared.payloadHash,
      );
      const cleared = yield* readPrHubReviewDraft(owner);
      assert.equal(cleared?.version, 2);
      assert.equal(cleared?.content.body, "");
      assert.equal(cleared?.frozen, false);
      yield* Migration086;
      yield* savePrHubReviewDraft(owner, { ...draft, expectedVersion: cleared!.version });
      const fresh = (yield* readPrHubReviewDraft(owner))!;
      const abandoned = yield* prepareReviewOperation(owner, {
        ...input,
        id: "abandoned",
        expectedVersion: fresh.version,
      });
      yield* transitionReviewOperation(owner, {
        id: abandoned.id,
        from: "prepared",
        to: "creating",
      });
      yield* transitionReviewOperation(owner, {
        id: abandoned.id,
        from: "creating",
        to: "abandoned",
      });
      assert.equal((yield* readPrHubReviewDraft(owner))?.content.body, draft.content.body);
      assert.equal((yield* readPrHubReviewDraft(owner))?.frozen, false);
      assert.equal(
        (yield* readReviewOperation(owner, abandoned.id))?.payloadHash,
        abandoned.payloadHash,
      );
      const next = yield* prepareReviewOperation(owner, {
        ...input,
        id: "new-intent",
        expectedVersion: fresh.version,
      });
      assert.equal(next.status, "prepared");
    }),
  );
});
