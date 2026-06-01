import { describe, expect, it } from "vitest";

import { enforceTurnItemBudget, MAX_RETAINED_TURN_ITEM_CHARS } from "./claudeTurnRetention.ts";

function makeTurn(approximateChars: number, itemCount = 1) {
  return {
    items: Array.from({ length: itemCount }, (_, index) => ({ value: index })) as Array<unknown>,
    approximateChars,
  };
}

describe("enforceTurnItemBudget", () => {
  it("leaves items intact when total retained chars are within budget", () => {
    const turns = [makeTurn(10), makeTurn(20), makeTurn(30)];

    enforceTurnItemBudget(turns, 1_000);

    expect(turns.map((turn) => turn.items.length)).toEqual([1, 1, 1]);
  });

  it("evicts oldest turn bodies first until within budget", () => {
    const turns = [makeTurn(100), makeTurn(100), makeTurn(100), makeTurn(100)];

    enforceTurnItemBudget(turns, 250);

    // Oldest two evicted (200 + remaining 200 > 250 -> drop one more): keep last two.
    expect(turns.map((turn) => turn.items.length)).toEqual([0, 0, 1, 1]);
  });

  it("always preserves the most recent turn body even when it exceeds the budget", () => {
    const turns = [makeTurn(100), makeTurn(5_000)];

    enforceTurnItemBudget(turns, 1_000);

    expect(turns[0]!.items.length).toBe(0);
    expect(turns[1]!.items.length).toBe(1);
  });

  it("never mutates approximateChars or the turns array length", () => {
    const turns = [makeTurn(400), makeTurn(400), makeTurn(400)];

    enforceTurnItemBudget(turns, 500);

    expect(turns).toHaveLength(3);
    expect(turns.map((turn) => turn.approximateChars)).toEqual([400, 400, 400]);
  });

  it("ignores already-evicted turns when computing the retained total", () => {
    const turns = [
      { items: [] as Array<unknown>, approximateChars: 10_000 },
      makeTurn(100),
      makeTurn(100),
    ];

    enforceTurnItemBudget(turns, 1_000);

    // The empty oldest turn does not count toward the budget, so nothing is evicted.
    expect(turns.map((turn) => turn.items.length)).toEqual([0, 1, 1]);
  });

  it("handles empty and single-turn archives", () => {
    expect(() => enforceTurnItemBudget([], 10)).not.toThrow();

    const single = [makeTurn(10_000)];
    enforceTurnItemBudget(single, 1);
    expect(single[0]!.items.length).toBe(1);
  });

  it("exposes a positive default budget", () => {
    expect(MAX_RETAINED_TURN_ITEM_CHARS).toBeGreaterThan(0);
  });
});
