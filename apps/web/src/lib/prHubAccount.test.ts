import { afterEach, describe, expect, it } from "vitest";
import { assertPrHubAccountGeneration } from "./prHubAccount";
import { prHubQueryKeys } from "./prHubReactQuery";
import { PullRequestKey } from "@t3tools/contracts";
import { getPrHubDraftIdentity, setPrHubAccount, setPrHubAccountGeneration } from "./prHubAccount";
afterEach(() => setPrHubAccount(undefined));
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
it("keeps draft ownership stable across restarts but fences an unverified account change", () => {
  setPrHubAccount({ host: "github.com", viewerId: 1, generation: "before" });
  const before = getPrHubDraftIdentity();
  setPrHubAccountGeneration("after");
  expect(getPrHubDraftIdentity()).toBeUndefined();
  setPrHubAccount({ host: "github.com", viewerId: 1, generation: "after" });
  expect(getPrHubDraftIdentity()).toEqual(before);
  setPrHubAccount({ host: "github.com", viewerId: 2, generation: "other" });
  expect(getPrHubDraftIdentity()).not.toEqual(before);
  setPrHubAccount(undefined);
});
