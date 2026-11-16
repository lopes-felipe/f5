import { describe, expect, it } from "vitest";

import { canRepairErroredTurnFromSuccessfulSettlement } from "./turnStateTransitions.ts";

describe("canRepairErroredTurnFromSuccessfulSettlement", () => {
  const base = {
    turnId: "turn-1",
    state: "error",
    completedAt: "2026-08-31T16:15:03.000Z",
    settledTurnId: "turn-1",
    settlementAt: "2026-08-31T16:34:11.000Z",
  } as const;

  it("accepts a later successful settlement for the same errored turn", () => {
    expect(
      canRepairErroredTurnFromSuccessfulSettlement(base, base.settledTurnId, base.settlementAt),
    ).toBe(true);
  });

  it("rejects stale, mismatched, and non-errored settlements", () => {
    expect(
      canRepairErroredTurnFromSuccessfulSettlement(
        base,
        base.settledTurnId,
        "2026-08-31T16:15:02.000Z",
      ),
    ).toBe(false);
    expect(canRepairErroredTurnFromSuccessfulSettlement(base, "turn-2", base.settlementAt)).toBe(
      false,
    );
    expect(
      canRepairErroredTurnFromSuccessfulSettlement(
        { ...base, state: "completed" },
        base.settledTurnId,
        base.settlementAt,
      ),
    ).toBe(false);
  });
});
