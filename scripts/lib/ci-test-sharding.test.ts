import { describe, expect, it } from "vitest";
import { allocateShards, median, sortByDuration } from "./ci-test-sharding.ts";

describe("duration-based CI sharding", () => {
  it("balances expensive files instead of putting both on the same shard", () => {
    const weights = { a: 360, b: 350, c: 100, d: 90, e: 80, f: 70 };
    const shards = allocateShards(Object.keys(weights), weights, 3);
    expect(shards).toEqual([["a"], ["b"], ["c", "d", "e", "f"]]);
  });

  it.each([2, 3])("assigns every file exactly once across %s shards", (count) => {
    const files = Array.from({ length: 617 }, (_, i) => String(i));
    const weights = Object.fromEntries(files.map((file, i) => [file, (i % 17) + 1]));
    const shards = allocateShards(files, weights, count);
    expect(shards.flat().sort()).toEqual([...files].sort());
    expect(allocateShards([...files].reverse(), weights, count)).toEqual(shards);
  });

  it("uses the platform median for new files and stable paths for ties", () => {
    expect(median([10, 100, 20, 30])).toBe(25);
    expect(sortByDuration(["z", "new-b", "a", "new-a"], { a: 10, z: 30 })).toEqual([
      "z",
      "new-a",
      "new-b",
      "a",
    ]);
    expect(allocateShards(["b", "a", "c"], {}, 2)).toEqual([["a", "c"], ["b"]]);
  });

  it("handles empty inventories and more shards than files", () => {
    expect(allocateShards([], {}, 2)).toEqual([[], []]);
    expect(allocateShards(["a"], {}, 3)).toEqual([["a"], [], []]);
  });

  it("rejects invalid counts, duplicate files and corrupt timing data", () => {
    for (const count of [0, -1, 1.5, NaN])
      expect(() => allocateShards([], {}, count)).toThrow("Invalid shard count");
    expect(() => allocateShards(["a", "a"], {}, 2)).toThrow("Duplicate");
    for (const value of [0, -1, Infinity, NaN])
      expect(() => sortByDuration(["a"], { a: value })).toThrow("durations");
  });
});
