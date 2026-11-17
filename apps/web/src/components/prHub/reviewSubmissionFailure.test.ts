import { describe, expect, it } from "vitest";
import { reviewSubmissionFailure } from "./reviewSubmissionFailure";

describe("review submission failure", () => {
  it("trims host errors", () => {
    expect(
      reviewSubmissionFailure(
        new Error("  Can not approve your own pull request  "),
        "Draft preserved",
      ),
    ).toBe("Can not approve your own pull request");
  });

  it("caps long descriptions", () => {
    expect(reviewSubmissionFailure("x".repeat(500), "Draft preserved")).toBe("x".repeat(319) + "…");
  });

  it.each([undefined, {}, "", "  "])("uses the fallback for an absent message: %j", (failure) => {
    expect(reviewSubmissionFailure(failure, "Draft preserved")).toBe("Draft preserved");
  });
});
