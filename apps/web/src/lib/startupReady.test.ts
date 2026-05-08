import { describe, expect, it } from "vitest";

import { isStartupReady } from "./startupReady";

describe("isStartupReady", () => {
  it.each([
    { threadsHydrated: false, recoveryEpoch: 0, expected: false },
    { threadsHydrated: true, recoveryEpoch: 0, expected: false },
    { threadsHydrated: false, recoveryEpoch: 1, expected: false },
    { threadsHydrated: true, recoveryEpoch: 1, expected: true },
    { threadsHydrated: true, recoveryEpoch: 5, expected: true },
  ])(
    "returns $expected for threadsHydrated=$threadsHydrated and recoveryEpoch=$recoveryEpoch",
    ({ threadsHydrated, recoveryEpoch, expected }) => {
      expect(isStartupReady({ threadsHydrated, recoveryEpoch })).toBe(expected);
    },
  );
});
