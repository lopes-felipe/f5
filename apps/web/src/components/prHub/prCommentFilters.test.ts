import { describe, expect, it } from "vitest";
import type { PrHubReviewThread } from "@t3tools/contracts";
import { isBotReviewComment, visibleReviewThreads } from "./prCommentFilters";
const thread = (
  id: string,
  author: string | null,
  extra: Partial<PrHubReviewThread> = {},
): PrHubReviewThread => ({
  id,
  isResolved: false,
  path: "a.ts",
  line: 1,
  originalLine: 1,
  comments: [
    {
      id,
      url: "",
      author,
      bodyText: id,
      createdAt: null,
      updatedAt: null,
      outdated: false,
      diffHunk: null,
    },
  ],
  ...extra,
});
describe("PR comment filters", () => {
  it("keeps human and unknown authors and recognizes only bot metadata or the bot suffix", () => {
    expect(isBotReviewComment({ author: "botanist" })).toBe(false);
    expect(isBotReviewComment({ author: null })).toBe(false);
    expect(isBotReviewComment({ author: "automation", authorIsBot: true })).toBe(true);
    expect(isBotReviewComment({ author: "dependabot[BOT]" })).toBe(true);
  });
  it("keeps paginated bot roots reachable for human replies and independently filters resolved threads", () => {
    const threads = [
      thread("bot", "ci[bot]"),
      thread("paged", "ci[bot]", {
        commentsPageInfo: { hasNextPage: true, endCursor: "next", truncated: false },
      }),
      thread("human", "alice"),
      thread("resolved", "alice", { isResolved: true }),
    ];
    expect(
      visibleReviewThreads(threads, { bots: false, resolved: false }).map((t) => t.id),
    ).toEqual(["paged", "human"]);
    expect(visibleReviewThreads(threads, { bots: true, resolved: false }).map((t) => t.id)).toEqual(
      ["bot", "paged", "human"],
    );
    expect(visibleReviewThreads(threads, { bots: false, resolved: true }).map((t) => t.id)).toEqual(
      ["paged", "human", "resolved"],
    );
  });
});
