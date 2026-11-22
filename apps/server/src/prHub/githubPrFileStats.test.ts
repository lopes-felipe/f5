import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { GitHubApiResponse } from "../git/githubApi";
import { readGitHubFileStats, PR_FILE_STATS_QUERY } from "./githubPrFileStats";

const response = (cursor: string | null, moved = false): GitHubApiResponse =>
  ({
    body: {
      data: {
        repository: {
          pullRequest: {
            headRefOid: moved ? "moved" : "head",
            baseRefOid: "base",
            changedFiles: 2,
            files: {
              nodes: [{ path: cursor ? "test/a.test.ts" : "src/a.ts", additions: 3, deletions: 1 }],
              pageInfo: { hasNextPage: !cursor, endCursor: cursor ? null : "next" },
            },
          },
        },
      },
    },
    graphqlErrors: [],
  }) as unknown as GitHubApiResponse;

describe("GitHub file statistics", () => {
  it("reads only stats and adds all pages", async () => {
    let calls = 0;
    const value = await Effect.runPromise(
      readGitHubFileStats((cursor) =>
        Effect.sync(() => {
          calls++;
          return response(cursor);
        }),
      ),
    );
    expect(calls).toBe(2);
    expect(value?.breakdown.code.additions).toBe(3);
    expect(value?.breakdown.tests.additions).toBe(3);
    expect(value?.headOid).toBe("head");
    expect(value?.baseOid).toBe("base");
    expect(PR_FILE_STATS_QUERY).not.toMatch(/\bpatch\b/);
  });
  it("refuses a comparison changed between pages", async () => {
    const value = await Effect.runPromise(
      readGitHubFileStats((cursor) => Effect.succeed(response(cursor, cursor !== null))),
    );
    expect(value).toBeNull();
  });
});
