import { describe, expect, it } from "vitest";
import { decodeUnresolvedThreads } from "./reviewThreads";

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
