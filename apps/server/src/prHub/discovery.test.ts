import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqliteClient from "../persistence/NodeSqliteClient.ts";
import Migration081 from "../persistence/Migrations/081_PrHubSyncTasks.ts";
import {
  finishPrHubHydration,
  beginPrHubSearch,
  ingestPrHubSearch,
  resumePrHubSearch,
  selectPrHubHydration,
  recordPrHubMembership,
} from "./discovery.ts";

const account = { host: "github.com", viewerId: "1" };
const task = { alias: "author", query: "is:pr author:me", cursor: null };
const node = (id: string, repository = "org/repo", updatedAt = "2026-01-01T00:00:00Z") => ({
  id,
  repository: { nameWithOwner: repository },
  updatedAt,
});

const reset = Effect.gen(function* () {
  yield* Migration081;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM pr_hub_sync_tasks`;
});

it.layer(SqliteClient.layerMemory())("resumable PR discovery", (it) => {
  it.effect(
    "discovers a viewer beyond the first participant page and completes the repository scope",
    () =>
      Effect.gen(function* () {
        yield* reset;
        const viewer = { ...account, viewerLogin: "me" };
        yield* ingestPrHubSearch(
          viewer,
          { ...task, query: "is:pr repo:org/repo", from: 1000, to: 2000 },
          { issueCount: 1000, nodes: [], pageInfo: { hasNextPage: true, endCursor: "capped" } },
          new Set(),
        );
        const empty = { nodes: [], totalCount: 0, pageInfo: { hasNextPage: false } };
        const pr = {
          ...node("large"),
          author: { login: "other" },
          assignees: empty,
          reviewRequests: empty,
          participants: {
            nodes: [{ id: "someone", login: "someone" }],
            totalCount: 2,
            pageInfo: { hasNextPage: true, endCursor: "participants1" },
          },
        };
        yield* resumePrHubSearch(viewer, new Set(), (document, variables) => {
          if (document.includes("PrHubRepositoryPullRequests"))
            return Effect.succeed({
              data: {
                repository: { pullRequests: { nodes: [pr], pageInfo: { hasNextPage: false } } },
              },
            });
          assert.equal(variables.cursor, "participants1");
          return Effect.succeed({
            data: {
              node: {
                ...pr,
                participants: {
                  nodes: [{ id: "viewer", login: "me" }],
                  totalCount: 2,
                  pageInfo: { hasNextPage: false, endCursor: "participants2" },
                },
              },
            },
          });
        });
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM pr_hub_sync_tasks WHERE kind = 'hydrate'`;
        assert.equal(rows.length, 1);
        assert.deepStrictEqual(JSON.parse(rows[0]!.payload_json).aliases, ["involved"]);
        const remaining = yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM pr_hub_sync_tasks WHERE kind = 'search'`;
        assert.equal(remaining[0]!.count, 0);
      }),
  );
  it.effect(
    "reserves twenty oldest records and puts active review requests ahead of newer cold records",
    () =>
      Effect.gen(function* () {
        yield* reset;
        for (const [prefix, alias, count, at, updated] of [
          ["old", "involved", 80, 1000, "2026-01-01T00:00:00Z"],
          ["new", "involved", 80, 2000, "2026-03-01T00:00:00Z"],
          ["review", "review_requested", 60, 3000, "2026-02-01T00:00:00Z"],
        ] as const)
          yield* ingestPrHubSearch(
            account,
            { ...task, alias },
            {
              nodes: Array.from({ length: count }, (_, i) =>
                node(`${prefix}-${i}`, "org/repo", updated),
              ),
              issueCount: count,
              pageInfo: { hasNextPage: false, endCursor: null },
            },
            new Set(),
            at,
          );
        const selected = [...(yield* selectPrHubHydration(account, new Set(), 4000)).keys()];
        assert.equal(selected.length, 80);
        assert.equal(selected.filter((id) => id.startsWith("old-")).length, 20);
        assert.equal(selected.filter((id) => id.startsWith("review-")).length, 60);
      }),
  );
  it.effect(
    "changes discovery generation only for verified membership changes and invalidates old pages",
    () =>
      Effect.gen(function* () {
        yield* reset;
        const sql = yield* SqlClient.SqlClient;
        const first = yield* recordPrHubMembership(account, "teams", ["org/a", "org/b"]);
        const unchanged = yield* recordPrHubMembership(account, "teams", ["ORG/B", "org/a"]);
        assert.equal(unchanged.generation, first.generation);
        assert.isFalse(unchanged.changed);
        const scope = yield* beginPrHubSearch(
          account,
          "team_review",
          "is:pr team-review-requested:org/a",
        );
        yield* ingestPrHubSearch(
          account,
          scope,
          { nodes: [node("tracked")], pageInfo: { hasNextPage: true, endCursor: "next" } },
          new Set(),
        );
        const changed = yield* recordPrHubMembership(account, "teams", ["org/b"]);
        assert.isTrue(changed.changed);
        assert.notEqual(changed.generation, first.generation);
        const rows = yield* sql<{ kind: string }>`SELECT kind FROM pr_hub_sync_tasks`;
        assert.deepStrictEqual(rows.map((row) => row.kind).sort(), ["hydrate", "membership"]);
      }),
  );
  it.effect("escapes a saturated repository leaf and hydrates only verified relationships", () =>
    Effect.gen(function* () {
      yield* reset;
      const sql = yield* SqlClient.SqlClient;
      const viewer = { ...account, viewerLogin: "me", viewerTeams: ["org/reviewers"] };
      yield* ingestPrHubSearch(
        viewer,
        { ...task, query: "is:pr is:open author:me repo:org/repo", from: 1000, to: 2000 },
        {
          issueCount: 1000,
          nodes: [],
          pageInfo: { hasNextPage: true, endCursor: "capped" },
        },
        new Set(),
        2000,
      );
      const empty = { nodes: [], pageInfo: { hasNextPage: false } };
      yield* resumePrHubSearch(viewer, new Set(), (document, variables) => {
        assert.include(document, "PrHubRepositoryPullRequests");
        assert.deepStrictEqual(variables, { owner: "org", name: "repo", cursor: null });
        return Effect.succeed({
          data: {
            repository: {
              pullRequests: {
                nodes: [
                  {
                    ...node("unrelated"),
                    author: { login: "other" },
                    assignees: empty,
                    participants: empty,
                    reviewRequests: empty,
                  },
                  {
                    ...node("team-request"),
                    author: { login: "other" },
                    assignees: empty,
                    participants: empty,
                    reviewRequests: {
                      nodes: [{ requestedReviewer: { combinedSlug: "org/reviewers" } }],
                      pageInfo: { hasNextPage: false },
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        });
      });
      const rows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM pr_hub_sync_tasks WHERE kind = 'hydrate'`;
      assert.equal(rows.length, 1);
      assert.equal(JSON.parse(rows[0]!.payload_json).nodeId, "team-request");
      assert.deepStrictEqual(JSON.parse(rows[0]!.payload_json).aliases, ["team_review"]);
      const remaining = yield* sql<{
        count: number;
      }>`SELECT count(*) AS count FROM pr_hub_sync_tasks WHERE kind = 'search'`;
      assert.equal(remaining[0]!.count, 0);
    }),
  );
  it.effect("retains malformed and non-advancing pages without advancing coverage", () =>
    Effect.gen(function* () {
      yield* reset;
      const sql = yield* SqlClient.SqlClient;
      const scope = yield* beginPrHubSearch(account, "author", task.query, 1000);
      const result = yield* ingestPrHubSearch(account, scope, { nodes: [] }, new Set(), 1000);
      assert.isTrue(result.partial);
      yield* resumePrHubSearch(account, new Set(), () =>
        Effect.succeed({
          data: { result: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "next" } } },
        }),
      );
      yield* resumePrHubSearch(account, new Set(), () =>
        Effect.succeed({
          data: { result: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "next" } } },
        }),
      );
      const rows = yield* sql<{
        kind: string;
        payload_json: string;
      }>`SELECT kind, payload_json FROM pr_hub_sync_tasks`;
      assert.isFalse(
        JSON.parse(rows.find((row) => row.kind === "source_watermark")!.payload_json).complete,
      );
      assert.equal(
        JSON.parse(rows.find((row) => row.kind === "search")!.payload_json).cursor,
        "next",
      );
    }),
  );
  it.effect(
    "resumes interrupted intervals and advances watermarks only after their final page",
    () =>
      Effect.gen(function* () {
        yield* reset;
        const start = Date.parse("2026-01-01T12:00:00.000Z");
        const first = yield* beginPrHubSearch(account, "author", task.query, start);
        yield* ingestPrHubSearch(
          account,
          first,
          {
            issueCount: 150,
            nodes: [node("one")],
            pageInfo: { hasNextPage: true, endCursor: "next" },
          },
          new Set(),
          start,
        );
        const resumed = yield* beginPrHubSearch(account, "author", task.query, start + 3600_000);
        assert.deepStrictEqual(resumed, first);
        yield* resumePrHubSearch(account, new Set(), (_, variables) => {
          assert.equal(variables.cursor, "next");
          assert.equal(variables.query, first.query);
          return Effect.succeed({
            data: {
              result: {
                issueCount: 150,
                nodes: [node("two")],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          });
        });
        const next = yield* beginPrHubSearch(account, "author", task.query, start + 3600_000);
        assert.include(next.query, "updated:2026-01-01T11:50:00.000Z..2026-01-01T13:00:00.000Z");
        yield* ingestPrHubSearch(
          account,
          next,
          { issueCount: 0, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          new Set(),
          start + 3600_000,
        );
        const repair = yield* beginPrHubSearch(account, "author", task.query, start + 7 * 3600_000);
        assert.include(repair.query, "updated:<=2026-01-01T19:00:00.000Z");
      }),
  );

  it.effect("keeps a continuation cursor when a later poll repeats the first page", () =>
    Effect.gen(function* () {
      yield* reset;
      const sql = yield* SqlClient.SqlClient;
      const first = {
        issueCount: 300,
        nodes: [node("one")],
        pageInfo: { hasNextPage: true, endCursor: "page-two" },
      };
      yield* ingestPrHubSearch(account, task, first, new Set());
      yield* resumePrHubSearch(account, new Set(), (_, variables) => {
        assert.equal(variables.cursor, "page-two");
        return Effect.succeed({
          data: {
            result: {
              issueCount: 300,
              nodes: [node("two")],
              pageInfo: { hasNextPage: true, endCursor: "page-three" },
            },
          },
        });
      });
      yield* ingestPrHubSearch(account, task, first, new Set());
      const rows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM pr_hub_sync_tasks WHERE kind = 'search'`;
      assert.equal(JSON.parse(rows[0]!.payload_json).cursor, "page-three");
      yield* resumePrHubSearch(account, new Set(), (_, variables) => {
        assert.equal(variables.cursor, "page-three");
        return Effect.succeed({
          data: {
            result: {
              issueCount: 300,
              nodes: [node("three")],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      });
      const pending = yield* sql<{
        count: number;
      }>`SELECT count(*) AS count FROM pr_hub_sync_tasks WHERE kind = 'search'`;
      assert.equal(pending[0]!.count, 0);
      assert.equal((yield* selectPrHubHydration(account, new Set())).size, 3);
    }),
  );
  it.effect("splits saturated search ranges and excludes repository hydration", () =>
    Effect.gen(function* () {
      yield* reset;
      const sql = yield* SqlClient.SqlClient;
      yield* ingestPrHubSearch(
        account,
        task,
        {
          issueCount: 1000,
          nodes: [node("excluded", "org/private"), node("included")],
          pageInfo: { hasNextPage: true, endCursor: "cap" },
        },
        new Set(["org/private"]),
        200_000,
      );
      const partitions = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM pr_hub_sync_tasks WHERE kind = 'search'`;
      assert.equal(partitions.length, 2);
      assert.deepStrictEqual(
        partitions.map((row) => JSON.parse(row.payload_json).from).sort((a, b) => a - b),
        [0, 100_000],
      );
      assert.deepStrictEqual(
        [...(yield* selectPrHubHydration(account, new Set())).keys()],
        ["included"],
      );
      assert.equal((yield* selectPrHubHydration(account, new Set(["org/repo"]))).size, 0);
    }),
  );
  it.effect("hydrates at most eighty and reserves cold-record progress", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* ingestPrHubSearch(
        account,
        task,
        {
          issueCount: 200,
          nodes: Array.from({ length: 200 }, (_, i) => node(`old-${String(i).padStart(3, "0")}`)),
          pageInfo: { hasNextPage: false },
        },
        new Set(),
        1000,
      );
      const first = yield* selectPrHubHydration(account, new Set(), 1000);
      assert.equal(first.size, 80);
      yield* finishPrHubHydration(account, [...first.keys()]);
      yield* ingestPrHubSearch(
        account,
        task,
        {
          issueCount: 200,
          nodes: Array.from({ length: 200 }, (_, i) =>
            node(`new-${i}`, "org/repo", "2026-02-01T00:00:00Z"),
          ),
          pageInfo: { hasNextPage: false },
        },
        new Set(),
        2000,
      );
      assert.equal((yield* selectPrHubHydration(account, new Set(), 2000)).size, 0);
      const second = yield* selectPrHubHydration(account, new Set(), 181001);
      assert.equal(second.size, 80);
      assert.equal([...second.keys()].filter((key) => key.startsWith("old-")).length, 20);
      assert.equal((yield* selectPrHubHydration({ ...account, viewerId: "2" }, new Set())).size, 0);
    }),
  );
});
