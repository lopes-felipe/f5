import { describe, expect, it } from "vitest";
import { reviewFailureDescription } from "./prReviewFailure";

describe("reviewFailureDescription", () => {
  it("shows the host reason without the operation wrapper", () => {
    expect(
      reviewFailureDescription(
        new Error(
          "Pull request operation submitReview failed: You cannot approve your own pull request.",
        ),
      ),
    ).toBe("You cannot approve your own pull request.");
    expect(reviewFailureDescription("Pull request operation failed: Review is invalid")).toBe(
      "Review is invalid",
    );
  });

  it.each([
    undefined,
    null,
    {},
    "",
    "  ",
    new Error(""),
    "Unknown error",
    "GitHub API command failed.",
    "exited with code 1",
    "Pull request operation submitReview failed: ",
  ])("explains draft preservation when no useful reason is available (%s)", (failure) => {
    expect(reviewFailureDescription(failure)).toBe(
      "The host refused the review. Your draft is still here to try again.",
    );
  });

  it("bounds long host messages", () => {
    expect(reviewFailureDescription("x".repeat(400))).toBe("x".repeat(319) + "…");
  });
});
