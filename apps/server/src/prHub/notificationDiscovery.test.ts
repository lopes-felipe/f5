import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqliteClient from "../persistence/NodeSqliteClient.ts";
import Migration081 from "../persistence/Migrations/081_PrHubSyncTasks.ts";
import { discoverNotificationSubjects, notificationPullRequest } from "./notificationDiscovery.ts";
import type { GitHubApiResponse } from "../git/githubApi.ts";
import { SourceControlProviderError } from "../sourceControl/SourceControlProvider.ts";

const subject = (repo = "org/repo", host = "api.github.com") => ({
  reason: "mention",
  repository: { full_name: repo },
  subject: { type: "PullRequest", url: `https://${host}/repos/${repo}/pulls/1` },
});
const response = (body: unknown, next = false) =>
  ({
    body,
    status: 200,
    links: next ? { next: "ignored-provider-url" } : {},
    graphqlErrors: [],
    etag: null,
    lastModified: null,
    rateLimit: {},
    rateLimitResource: null,
  }) as GitHubApiResponse;
const account = { host: "github.com", viewerId: "1" };

it("accepts only matching repository subjects on the captured API host", () => {
  assert.equal(
    notificationPullRequest(subject(), "github.com")?.endpoint,
    "repos/org/repo/pulls/1",
  );
  assert.equal(
    notificationPullRequest(subject("org/repo", "attacker.invalid"), "github.com"),
    null,
  );
  assert.equal(
    notificationPullRequest(
      { ...subject(), repository: { full_name: "other/repo" } },
      "github.com",
    ),
    null,
  );
});

it.layer(SqliteClient.layerMemory())("notification discovery", (it) => {
  it.effect("resumes pages, excludes subjects before reads, and queues mention evidence", () =>
    Effect.gen(function* () {
      yield* Migration081;
      const calls: string[] = [];
      const complete = yield* discoverNotificationSubjects(
        account,
        new Set(["org/private"]),
        (endpoint) => {
          calls.push(endpoint);
          return Effect.succeed(
            endpoint === "notifications"
              ? response([subject(), subject(), subject("org/private")], true)
              : response({ node_id: "PR_1", updated_at: "2026-01-01T00:00:00Z" }),
          );
        },
        1000,
      );
      assert.isFalse(complete);
      assert.deepStrictEqual(calls, ["notifications", "repos/org/repo/pulls/1"]);
      const failed = yield* Effect.exit(
        discoverNotificationSubjects(
          account,
          new Set(),
          (_, query) => {
            assert.equal(query?.page, 2);
            return Effect.fail(
              new SourceControlProviderError({
                provider: "github",
                operation: "test",
                kind: "forbidden",
                detail: "No permission",
              }),
            );
          },
          2000,
        ),
      );
      assert.equal(failed._tag, "Failure");
      yield* discoverNotificationSubjects(
        account,
        new Set(),
        (_, query) => {
          assert.equal(query?.page, 2);
          return Effect.succeed(response([]));
        },
        3000,
      );
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM pr_hub_sync_tasks WHERE kind = 'hydrate'`;
      assert.deepStrictEqual(JSON.parse(rows[0]!.payload_json).aliases, ["mentioned"]);
      yield* discoverNotificationSubjects(
        account,
        new Set(),
        (_, query) => {
          assert.equal(query?.page, 1);
          assert.equal(query?.since, "1970-01-01T00:00:00.000Z");
          assert.equal(query?.before, "1970-01-01T00:00:04.000Z");
          return Effect.succeed(response([]));
        },
        4000,
      );
      yield* discoverNotificationSubjects(
        account,
        new Set(),
        (_, query) => {
          assert.equal(query?.since, undefined);
          assert.equal(query?.before, new Date(7 * 60 * 60_000).toISOString());
          return Effect.succeed(response([]));
        },
        7 * 60 * 60_000,
      );
    }),
  );
});

it.layer(SqliteClient.layerMemory())("inaccessible notification subjects", (it) => {
  it.effect("retires excluded retries without reading the excluded repository", () =>
    Effect.gen(function* () {
      yield* Migration081;
      assert.isFalse(
        yield* discoverNotificationSubjects(
          account,
          new Set(),
          (endpoint) =>
            Effect.succeed(
              endpoint === "notifications"
                ? response([subject("org/private")])
                : { ...response({ message: "not found" }), status: 404 },
            ),
          1000,
        ),
      );
      const calls: string[] = [];
      assert.isTrue(
        yield* discoverNotificationSubjects(
          account,
          new Set(["org/private"]),
          (endpoint) => {
            calls.push(endpoint);
            return Effect.succeed(response([]));
          },
          2000,
        ),
      );
      assert.deepStrictEqual(calls, ["notifications"]);
      const sql = yield* SqlClient.SqlClient;
      const remaining =
        yield* sql`SELECT task_key FROM pr_hub_sync_tasks WHERE kind='notification_subject_retry'`;
      assert.equal(remaining.length, 0);
    }),
  );
  it.effect("continues accessible subjects, reports partial coverage and retries failures", () =>
    Effect.gen(function* () {
      yield* Migration081;
      let accessible = false;
      const read = (endpoint: string) =>
        Effect.succeed(
          endpoint === "notifications"
            ? response([subject("org/private"), subject("org/public")])
            : endpoint.includes("/private/") && !accessible
              ? { ...response({ message: "not found" }), status: 404 }
              : response({ node_id: endpoint, updated_at: "2026-01-01T00:00:00Z" }),
        );
      assert.isFalse(yield* discoverNotificationSubjects(account, new Set(), read, 1000));
      const sql = yield* SqlClient.SqlClient;
      const hydrated = yield* sql<{
        task_key: string;
      }>`SELECT task_key FROM pr_hub_sync_tasks WHERE kind='hydrate'`;
      assert.equal(hydrated.length, 1);
      assert.ok(hydrated[0]?.task_key.includes("/public/"));
      accessible = true;
      assert.isTrue(yield* discoverNotificationSubjects(account, new Set(), read, 2000));
      const remaining =
        yield* sql`SELECT task_key FROM pr_hub_sync_tasks WHERE kind='notification_subject_retry'`;
      assert.equal(remaining.length, 0);
    }),
  );
});
