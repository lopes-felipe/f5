import { describe, expect, it } from "vitest";

import { timeOrderedUuid } from "./ids";

const RANDOM = "3f2b8c1d-9e4a-4b6c-a1d2-0123456789ab";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("timeOrderedUuid", () => {
  it("writes the millisecond timestamp and version 7 over a random UUID", () => {
    // 2026-11-12T19:00:00.000Z
    const id = timeOrderedUuid(RANDOM, 1_794_510_000_000);
    expect(id).toBe("01a1d121-8f80-7b6c-a1d2-0123456789ab");
    expect(id).toHaveLength(36);
    expect(Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16)).toBe(1_794_510_000_000);
  });

  it("keeps the variant and every random bit after the version digit", () => {
    expect(timeOrderedUuid(RANDOM, 0).slice(15)).toBe(RANDOM.slice(15));
    expect(timeOrderedUuid(RANDOM, 0)).toBe("00000000-0000-7b6c-a1d2-0123456789ab");
  });

  it("sorts by creation time as a string", () => {
    const times = [1, 255, 256, 65_536, 1_794_510_000_000, 1_794_510_000_001, 2 ** 47];
    const ids = times.map((time) => timeOrderedUuid(crypto.randomUUID(), time));
    expect(ids.toSorted()).toEqual(ids);
  });

  it("is a pure function of its inputs", () => {
    expect(timeOrderedUuid(RANDOM, 42)).toBe(timeOrderedUuid(RANDOM, 42));
  });

  it("defaults to a fresh random part and the current time", () => {
    const before = Date.now();
    const first = timeOrderedUuid();
    const second = timeOrderedUuid();
    const after = Date.now();
    expect(first).toMatch(UUID);
    expect(first).not.toBe(second);
    const time = Number.parseInt(first.slice(0, 8) + first.slice(9, 13), 16);
    expect(time).toBeGreaterThanOrEqual(before);
    expect(time).toBeLessThanOrEqual(after);
  });
});
