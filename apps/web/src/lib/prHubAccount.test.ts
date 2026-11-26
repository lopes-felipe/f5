import { afterEach, describe, expect, it } from "vitest";
import {
  assertPrHubAccountGeneration,
  getPrHubAccountSnapshot,
  getPrHubDraftIdentity,
  setPrHubAccount,
  setPrHubAccountGeneration,
  setPrHubSelectedAccountId,
  subscribePrHubAccount,
} from "./prHubAccount";
import { prHubQueryKeys } from "./prHubReactQuery";
import { PullRequestKey } from "@t3tools/contracts";

afterEach(() => {
  setPrHubSelectedAccountId(undefined);
  setPrHubAccount(undefined);
});

describe("PR Hub account snapshot store", () => {
  it("keeps snapshot identity stable when unchanged, notifies on changes, and ignores no-op writes", () => {
    const first = getPrHubAccountSnapshot();
    expect(getPrHubAccountSnapshot()).toBe(first);

    let notifications = 0;
    const unsubscribe = subscribePrHubAccount(() => {
      notifications += 1;
    });
    try {
      // No-op write should not notify or allocate a new snapshot
      setPrHubSelectedAccountId(undefined);
      expect(notifications).toBe(0);
      expect(getPrHubAccountSnapshot()).toBe(first);

      setPrHubSelectedAccountId("acct-a");
      expect(notifications).toBe(1);
      const afterSelect = getPrHubAccountSnapshot();
      expect(afterSelect).toEqual({ accountId: "acct-a", generation: undefined });
      expect(afterSelect).not.toBe(first);

      // Repeating the same selected account ID is a no-op
      setPrHubSelectedAccountId("acct-a");
      expect(notifications).toBe(1);
      expect(getPrHubAccountSnapshot()).toBe(afterSelect);

      // Updating generation notifies and updates snapshot
      setPrHubAccount({ host: "github.com", viewerId: 1, generation: "gen-1" });
      expect(notifications).toBe(2);
      expect(getPrHubAccountSnapshot()).toEqual({ accountId: "acct-a", generation: "gen-1" });

      // Setting identical generation is a no-op
      setPrHubAccountGeneration("gen-1");
      expect(notifications).toBe(2);
    } finally {
      unsubscribe();
    }
  });
});

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
