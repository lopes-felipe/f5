import { Effect } from "effect";
import { expect, it } from "vitest";
import { readViewerReviewedHead } from "./viewerReviewedHead.ts";
import type { GitHubApiResponse } from "../git/githubApi.ts";

it("finds a completed viewer review beyond the first page and rejects non-advancing history", async () => {
  const pages: number[] = [];
  const read = (page: number) => {
    pages.push(page);
    return Effect.succeed({
      status: 200,
      links: page === 1 ? { next: "next" } : {},
      body:
        page === 1
          ? Array.from({ length: 100 }, (_, id) => ({
              id,
              user: { id: 2 },
              state: "APPROVED",
              commit_id: "other",
            }))
          : [
              { id: 101, user: { id: 1 }, state: "COMMENTED", commit_id: "reviewed" },
              { id: 102, user: { id: 1 }, state: "PENDING", commit_id: "pending" },
            ],
    } as GitHubApiResponse);
  };
  expect(await Effect.runPromise(readViewerReviewedHead(1, read))).toBe("reviewed");
  expect(pages).toEqual([1, 2]);
  expect((await Effect.runPromiseExit(readViewerReviewedHead(1, () => read(1))))._tag).toBe(
    "Failure",
  );
});
