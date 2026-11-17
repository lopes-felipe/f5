import { describe, expect, it } from "vitest";
import { reviewSubmissionFailure } from "./reviewSubmissionFailure";

describe("review submission failure", () => {
  it("removes the operation prefix from host errors", () => {
    expect(
      reviewSubmissionFailure(
        new Error("Pull request operation failed: Can not approve your own pull request"),
        "Draft preserved",
      ),
    ).toBe("Can not approve your own pull request");
  });

  it.each([undefined, {}, "", "  ", "Pull request operation failed: "])(
    "uses the fallback for an absent message: %j",
    (failure) => {
      expect(reviewSubmissionFailure(failure, "Draft preserved")).toBe("Draft preserved");
    },
  );
});
