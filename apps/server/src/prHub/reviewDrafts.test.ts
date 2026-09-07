import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqliteClient from "../persistence/NodeSqliteClient.ts";
import Migration083 from "../persistence/Migrations/083_PrHubReviewDrafts.ts";
import { readPrHubReviewDraft, savePrHubReviewDraft } from "./reviewDrafts.ts";
import { PullRequestKey, type PrHubSaveReviewDraftInput } from "@t3tools/contracts";

it.layer(SqliteClient.layerMemory())("review drafts", (it) => {
  it.effect("preserves content across readers, rejects stale saves and isolates accounts", () =>
    Effect.gen(function* () {
      yield* Migration083;
      const owner = {
        provider: "github",
        host: "github.com",
        viewerId: "1",
        repo: "org/repo",
        number: 1,
      };
      const input: PrHubSaveReviewDraftInput = {
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
        content: {
          body: "Review notes — keep me",
          comments: [
            {
              id: "comment",
              path: "src/a.ts",
              side: "RIGHT",
              line: 4,
              commitOid: "head",
              body: "Please explain this.",
            },
          ],
          viewedFiles: [{ path: "src/a.ts", blobOid: "blob" }],
        },
      };
      const saved = yield* savePrHubReviewDraft(owner, input);
      assert.equal(saved.status, "ok");
      assert.equal(saved.draft?.version, 1);
      assert.deepStrictEqual((yield* readPrHubReviewDraft(owner))?.content, input.content);
      assert.equal(yield* readPrHubReviewDraft({ ...owner, viewerId: "2" }), null);
      assert.equal(yield* readPrHubReviewDraft({ ...owner, host: "enterprise.example" }), null);
      const conflict = yield* savePrHubReviewDraft(owner, {
        ...input,
        content: { ...input.content, body: "Other window" },
      });
      assert.equal(conflict.status, "version_conflict");
      assert.equal(conflict.draft?.content.body, input.content.body);
      const moved = yield* savePrHubReviewDraft(owner, {
        ...input,
        expectedVersion: 1,
        comparison: { ...input.comparison, headOid: "new-head" },
      });
      assert.equal(moved.status, "version_conflict");
      assert.equal((yield* readPrHubReviewDraft(owner))?.comparison.headOid, "head");
      const revalidated = yield* savePrHubReviewDraft(owner, {
        ...input,
        expectedVersion: 1,
        revalidate: true,
        comparison: { ...input.comparison, headOid: "new-head" },
        content: {
          ...input.content,
          comments: input.content.comments.map((comment) => ({
            ...comment,
            commitOid: "new-head",
          })),
        },
      });
      assert.equal(revalidated.status, "ok");
      assert.equal((yield* readPrHubReviewDraft(owner))?.comparison.headOid, "new-head");
      assert.equal(
        (yield* readPrHubReviewDraft(owner))?.content.comments[0]?.body,
        "Please explain this.",
      );
      assert.equal(
        (yield* savePrHubReviewDraft(owner, { ...input, expectedVersion: 1, revalidate: true }))
          .status,
        "version_conflict",
      );
    }),
  );
});
