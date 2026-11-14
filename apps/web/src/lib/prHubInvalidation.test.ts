import { PullRequestKey, type PrHubChanged } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  EMPTY_PR_HUB_CHANGE_BATCH,
  isPrHubQueryStale,
  mergePrHubChange,
} from "./prHubInvalidation";

const key = (number: number) => PullRequestKey.makeUnsafe(`github:github.com/octo/repo#${number}`);

const event = (overrides: Partial<PrHubChanged> = {}): PrHubChanged => ({
  accountGeneration: "account",
  revision: "1",
  changedKeys: [],
  removedKeys: [],
  counts: {} as PrHubChanged["counts"],
  resyncRequired: false,
  ...overrides,
});

const batchOf = (...events: PrHubChanged[]) =>
  events.reduce(mergePrHubChange, EMPTY_PR_HUB_CHANGE_BATCH);

describe("PR Hub change batches", () => {
  it("collects changed and removed keys across a burst", () => {
    const batch = batchOf(
      event({ changedKeys: [key(1)] }),
      event({ changedKeys: [key(1), key(2)], removedKeys: [key(3)] }),
    );
    expect([...batch.keys].toSorted()).toEqual([key(1), key(2), key(3)]);
    expect(batch.resync).toBe(false);
  });

  it("remembers a resync for the whole burst", () => {
    expect(batchOf(event({ resyncRequired: true }), event({ changedKeys: [key(1)] })).resync).toBe(
      true,
    );
  });
});

describe("PR Hub query staleness", () => {
  const changed = batchOf(event({ changedKeys: [key(1)], removedKeys: [key(2)] }));
  const quiet = batchOf(event());

  it("always re-reads the collection", () => {
    for (const batch of [quiet, changed]) {
      expect(isPrHubQueryStale(["prHub", "overview", "account", null], batch)).toBe(true);
      expect(isPrHubQueryStale(["prHub", "list", "account", { filter: "all" }], batch)).toBe(true);
    }
  });

  it("re-reads one pull request's data only when that pull request changed", () => {
    for (const kind of ["detail", "timeline", "files", "reviewThreads", "stack"]) {
      expect(isPrHubQueryStale(["prHub", kind, "account", key(1)], changed)).toBe(true);
      expect(isPrHubQueryStale(["prHub", kind, "account", key(2)], changed)).toBe(true);
      expect(isPrHubQueryStale(["prHub", kind, "account", key(9)], changed)).toBe(false);
      expect(isPrHubQueryStale(["prHub", kind, "account", key(1)], quiet)).toBe(false);
    }
    // Keys can sit deeper in the query key, or inside a list of keys.
    expect(isPrHubQueryStale(["prHub", "files", "account", key(1), "head", 2], changed)).toBe(true);
    expect(isPrHubQueryStale(["prHub", "advisories", "account", [key(9), key(1)]], changed)).toBe(
      true,
    );
    expect(isPrHubQueryStale(["prHub", "advisories", "account", [key(9)]], changed)).toBe(false);
  });

  it("re-reads reads keyed by URL whenever any pull request changed", () => {
    const url = "https://github.com/octo/repo/pull/9";
    expect(isPrHubQueryStale(["prHub", "peek", "account", url], changed)).toBe(true);
    expect(isPrHubQueryStale(["prHub", "linkedPanel", "account", url], changed)).toBe(true);
    expect(isPrHubQueryStale(["prHub", "peek", "account", url], quiet)).toBe(false);
  });

  it("re-reads everything on a resync and never touches other queries", () => {
    const resync = batchOf(event({ resyncRequired: true }));
    expect(isPrHubQueryStale(["prHub", "detail", "account", key(9)], resync)).toBe(true);
    expect(isPrHubQueryStale(["server", "config"], resync)).toBe(false);
    expect(isPrHubQueryStale(["git", "status", key(1)], changed)).toBe(false);
  });
});
