import { Exit } from "effect";
import { describe, expect, it } from "vitest";
import type { GitHubApiResponse } from "../git/githubApi.ts";
import { classifyPrWrite } from "./writeOutcome.ts";

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
      classifyPrWrite(Exit.succeed(response({ message: "Can not approve your own pull request" }))),
    ).toMatchObject({
      message: "Can not approve your own pull request",
      rejected: true,
      safeToRetry: false,
    });
  });

  it.each([null, {}, { message: "  " }, { message: 42 }])(
    "uses the review fallback when the host gives no message: %j",
    (body) => {
      expect(classifyPrWrite(Exit.succeed(response(body)), "Draft preserved").message).toBe(
        "Draft preserved",
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
      classifyPrWrite(Exit.succeed(response({ message: "server error" }, 500)), "Draft preserved"),
    ).toMatchObject({ safeToRetry: false, rejected: false, message: "server error" });
  });
});
