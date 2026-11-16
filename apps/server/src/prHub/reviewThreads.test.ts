import { describe, expect, it } from "vitest";
import {
  decodeUnresolvedThreads,
  parseReviewThreads,
  GITHUB_REVIEW_COMMENT_FIELDS,
} from "./reviewThreads";

const response = (nodes: unknown[], totalCount: number) => ({
  data: { repository: { pullRequest: { reviewThreads: { nodes, totalCount } } } },
});
describe("review thread coverage", () => {
  it("reports unseen threads even when the fetched page is entirely resolved", () => {
    expect(
      decodeUnresolvedThreads(
        response([{ id: "one", isResolved: true, comments: { nodes: [] } }], 101),
      ),
    ).toMatchObject({ threads: [], truncated: true, omittedCount: 100 });
  });
  it("reports omitted comments and preserves verbatim evidence", () => {
    const result = decodeUnresolvedThreads(
      response(
        [
          {
            id: "thread",
            isResolved: false,
            path: "src/a.ts",
            line: 5,
            comments: {
              totalCount: 21,
              nodes: [
                {
                  id: "comment",
                  bodyText: "Keep this exact\nfeedback",
                  author: { login: "alice" },
                },
              ],
            },
          },
        ],
        1,
      ),
    );
    expect(result.omittedCount).toBe(20);
    expect(result.threads[0]?.comments[0]?.bodyText).toBe("Keep this exact\nfeedback");
  });
  it("rejects partial and malformed responses instead of claiming an empty review", () => {
    expect(() => decodeUnresolvedThreads({ errors: [{ message: "denied" }], data: {} })).toThrow();
    expect(() => decodeUnresolvedThreads({ data: {} })).toThrow();
  });
});

it("retains explicit bot identity even when its login has no bot suffix", () => {
  expect(GITHUB_REVIEW_COMMENT_FIELDS).toContain("__typename");
  const [thread] = parseReviewThreads({
    nodes: [
      {
        id: "thread",
        comments: {
          nodes: [
            { id: "bot", author: { login: "assistant", __typename: "Bot" } },
            { id: "human", author: { login: "botanist", __typename: "User" } },
          ],
        },
      },
    ],
  });
  expect(thread?.comments[0]).toMatchObject({ author: "assistant", authorIsBot: true });
  expect(thread?.comments[1]?.authorIsBot).toBeUndefined();
});
