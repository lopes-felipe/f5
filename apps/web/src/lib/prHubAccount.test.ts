import { afterEach, describe, expect, it } from "vitest";
import { assertPrHubAccountGeneration, setPrHubAccountGeneration } from "./prHubAccount";
import { prHubQueryKeys } from "./prHubReactQuery";
import { PullRequestKey } from "@t3tools/contracts";

afterEach(() => setPrHubAccountGeneration(undefined));

describe("PR Hub account isolation", () => {
  it("rejects a response captured before an account switch", () => {
    setPrHubAccountGeneration("first");
    expect(() => assertPrHubAccountGeneration("first")).not.toThrow();
    setPrHubAccountGeneration("second");
    expect(() => assertPrHubAccountGeneration("first")).toThrow("account changed");
    expect(() => assertPrHubAccountGeneration(undefined)).toThrow("account changed");
  });

  it("partitions every detail cache by the account generation", () => {
    const key = PullRequestKey.makeUnsafe("github:github.com:owner/repo:1");
    for (const queryKey of [prHubQueryKeys.detail, prHubQueryKeys.timeline, prHubQueryKeys.files]) {
      setPrHubAccountGeneration("first");
      const before = queryKey(key);
      setPrHubAccountGeneration("second");
      expect(queryKey(key)).not.toEqual(before);
    }
    setPrHubAccountGeneration("first");
    const before = prHubQueryKeys.advisories([key]);
    setPrHubAccountGeneration("second");
    expect(prHubQueryKeys.advisories([key])).not.toEqual(before);
  });
});
