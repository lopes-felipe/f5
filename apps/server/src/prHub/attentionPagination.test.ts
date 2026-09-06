import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqliteClient from "../persistence/NodeSqliteClient.ts";
import Migration081 from "../persistence/Migrations/081_PrHubSyncTasks.ts";
import { continuePrConnectionPagination } from "./attentionPagination.ts";

const account = { host: "github.com", viewerId: "1" };
const initial = {
  id: "PR_1",
  headRefOid: "head",
  baseRefOid: "base",
  baseRefName: "main",
  updatedAt: "t1",
  reviewThreads: {
    totalCount: 3,
    nodes: [{ id: "resolved", isResolved: true }],
    pageInfo: { hasNextPage: true, endCursor: "page1" },
  },
  latestReviews: { nodes: [], totalCount: 0, pageInfo: { hasNextPage: false } },
};
const response = (id: string, more: boolean, updatedAt = "t1") => ({
  data: {
    node: {
      ...initial,
      updatedAt,
      reviewThreads: {
        totalCount: 3,
        nodes: [{ id, isResolved: false }],
        pageInfo: { hasNextPage: more, endCursor: id },
      },
    },
  },
});

it.layer(SqliteClient.layerMemory())("attention pagination", (it) => {
  it.effect("never reports a missing page boundary as complete", () =>
    Effect.gen(function* () {
      yield* Migration081;
      const result = yield* continuePrConnectionPagination(
        account,
        {
          ...initial,
          reviewThreads: { nodes: [] },
        },
        () => Effect.die("must not guess a cursor"),
      );
      assert.isFalse(result.complete);
    }),
  );
  it.effect("resumes after interruption, caches completion and resets changed comparisons", () =>
    Effect.gen(function* () {
      yield* Migration081;
      const first = yield* continuePrConnectionPagination(
        account,
        initial,
        (_document, variables) => {
          assert.equal(variables.cursor, "page1");
          return Effect.succeed(response("page2", true));
        },
      );
      assert.isFalse(first.complete);
      const interrupted = yield* continuePrConnectionPagination(account, initial, () =>
        Effect.fail("quota"),
      );
      assert.isFalse(interrupted.complete);
      const resumed = yield* continuePrConnectionPagination(
        account,
        initial,
        (_document, variables) => {
          assert.equal(variables.cursor, "page2");
          return Effect.succeed(response("page3", false));
        },
      );
      assert.isTrue(resumed.complete);
      assert.equal((resumed.node.reviewThreads as { nodes: unknown[] }).nodes.length, 3);
      const cached = yield* continuePrConnectionPagination(account, initial, () =>
        Effect.die("unexpected request"),
      );
      assert.isTrue(cached.complete);
      const changed = yield* continuePrConnectionPagination(
        account,
        { ...initial, headRefOid: "new-head" },
        (_document, variables) => {
          assert.equal(variables.cursor, "page1");
          return Effect.succeed(response("old-comparison", false));
        },
      );
      assert.isFalse(changed.complete);
      assert.equal((changed.node.reviewThreads as { nodes: unknown[] }).nodes.length, 1);
    }),
  );
  it.effect("isolates viewers and rejects repeated cursors and incomplete terminal pages", () =>
    Effect.gen(function* () {
      yield* Migration081;
      yield* continuePrConnectionPagination(account, initial, () =>
        Effect.succeed(response("page2", true)),
      );
      const other = yield* continuePrConnectionPagination(
        { ...account, viewerId: "2" },
        initial,
        (_document, variables) => {
          assert.equal(variables.cursor, "page1");
          return Effect.succeed(response("page1", true));
        },
      );
      assert.isFalse(other.complete);
      assert.equal((other.node.reviewThreads as { nodes: unknown[] }).nodes.length, 1);
      const short = yield* continuePrConnectionPagination(
        { ...account, viewerId: "2" },
        initial,
        () => Effect.succeed(response("page2", false)),
      );
      assert.isFalse(short.complete);
    }),
  );
});
