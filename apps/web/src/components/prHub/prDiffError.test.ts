import { describe, expect, it } from "vitest";
import { describePrDiffError } from "./prDiffError";

describe("PR diff errors", () => {
  it.each(["API rate limit exceeded", "Requests are rate-limited", "Too many requests"])(
    "explains a wrapped quota failure: %s",
    (reason) => {
      const result = describePrDiffError("RPC at http://localhost:1234: " + reason);
      expect(result.title).toBe("GitHub rate limit reached");
      expect(result.description).toContain("after the limit resets");
      expect(result.description).not.toContain("localhost");
    },
  );
  it("does not blame rate limits for connection failures", () => {
    const result = describePrDiffError("Failed to fetch http://localhost:1234");
    expect(result.title).toBe("Couldn't load the changes");
    expect(result.description).not.toContain("limit");
    expect(result.description).not.toContain("localhost");
  });
});
