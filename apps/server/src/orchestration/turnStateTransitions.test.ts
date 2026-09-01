import { describe, expect, it } from "vitest";

import { canRepairErroredTurnFromSuccessfulSettlement } from "./turnStateTransitions.ts";

describe("canRepairErroredTurnFromSuccessfulSettlement", () => {
  const base = {
    currentTurnId: "turn-1",
    currentState: "error",
    completedAt: "2026-08-31T16:15:03.000Z",
    settledTurnId: "turn-1",
    settlementAt: "2026-08-31T16:34:11.000Z",
  } as const;

  it("accepts a later successful settlement for the same errored turn", () => {
    expect(canRepairErroredTurnFromSuccessfulSettlement(base)).toBe(true);
  });

  it("rejects stale, mismatched, and non-errored settlements", () => {
    expect(
      canRepairErroredTurnFromSuccessfulSettlement({
        ...base,
        settlementAt: "2026-08-31T16:15:02.000Z",
      }),
    ).toBe(false);
    expect(
      canRepairErroredTurnFromSuccessfulSettlement({
        ...base,
        settledTurnId: "turn-2",
      }),
    ).toBe(false);
    expect(
      canRepairErroredTurnFromSuccessfulSettlement({
        ...base,
        currentState: "completed",
      }),
    ).toBe(false);
  });
});
