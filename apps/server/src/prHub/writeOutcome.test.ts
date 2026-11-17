import { Exit } from "effect";
import { describe, expect, it } from "vitest";
import type { GitHubApiResponse } from "../git/githubApi.ts";
import { classifyPrWrite, classifyReviewWrite } from "./writeOutcome.ts";

const response = (body: unknown, status = 422): GitHubApiResponse => ({
  status,
  body,
  graphqlErrors: [],
  links: {},
  etag: null,
  lastModified: null,
  rateLimit: { limit: 5000, remaining: 100, resetAt: null },
  rateLimitResource: "core",
});

describe("refused PR writes", () => {
  it("preserves the host's reason without permitting an automatic retry", () => {
    expect(
      classifyReviewWrite(
        Exit.succeed(
          response({
            message: "Unprocessable Entity",
            errors: ["Can not approve your own pull request"],
          }),
        ),
        "creation",
      ),
    ).toMatchObject({
      message: "Can not approve your own pull request",
      rejected: true,
      safeToRetry: false,
    });
  });

  it.each([null, {}, { message: "  " }, { message: 42 }, { message: "Validation Failed" }])(
    "uses the review fallback when the host gives no message: %j",
    (body) => {
      expect(classifyReviewWrite(Exit.succeed(response(body)), "creation").message).toBe(
        "The host refused the review. Your draft is still here to try again.",
      );
    },
  );

  it("keeps rate limits and uncertain outcomes distinct from refusals", () => {
    expect(classifyPrWrite(Exit.succeed(response({ message: "rate limited" }, 429)))).toMatchObject(
      {
        safeToRetry: true,
        rejected: false,
      },
    );
    expect(
      classifyReviewWrite(Exit.succeed(response({ message: "server error" }, 500)), "submission"),
    ).toMatchObject({
      safeToRetry: false,
      rejected: false,
      message:
        "GitHub returned HTTP 500. Inspect repository permissions and the saved submission before continuing.",
    });
  });

  it("reads validation details and retains submission recovery guidance", () => {
    expect(
      classifyReviewWrite(
        Exit.succeed(
          response({
            message: "Validation Failed",
            errors: [{ message: "Line is outside the diff" }],
          }),
        ),
        "submission",
      ).message,
    ).toBe("Line is outside the diff Check the saved submission state before retrying.");
  });

  it("leaves other PR write diagnostics unchanged", () => {
    expect(
      classifyPrWrite(
        Exit.succeed(
          response({
            message: "Unprocessable Entity",
            errors: ["Not allowed"],
          }),
        ),
      ).message,
    ).toBe(
      "GitHub returned HTTP 422. Inspect repository permissions and the saved submission before continuing.",
    );
  });
});
