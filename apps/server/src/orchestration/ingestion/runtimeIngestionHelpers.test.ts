import { EventId, type ProviderSessionCapabilities, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  contextTokensDispatchThreshold,
  providerTurnKey,
  reasoningStatusActivityId,
  sameSessionCapabilities,
} from "./runtimeIngestionHelpers.ts";

function makeCapabilities(
  overrides: Partial<ProviderSessionCapabilities> = {},
): ProviderSessionCapabilities {
  return {
    generation: 1,
    discovery: "discovered",
    checkedAt: "2026-01-01T00:00:00.000Z",
    actions: [],
    ...overrides,
  };
}

describe("runtimeIngestionHelpers", () => {
  it("computes context token dispatch thresholds and deterministic turn/activity keys", () => {
    expect(contextTokensDispatchThreshold(null)).toBe(2_000);
    expect(contextTokensDispatchThreshold(1_000_000)).toBe(10_000);
    expect(providerTurnKey(ThreadId.make("t1"), TurnId.make("turn-1"))).toBe("t1:turn-1");
    expect(reasoningStatusActivityId(ThreadId.make("t1"), TurnId.make("turn-1"))).toBe(
      EventId.make("reasoning-status:t1:turn-1"),
    );
  });

  it("compares provider session capabilities structurally while ignoring checkedAt", () => {
    expect(
      sameSessionCapabilities(
        makeCapabilities({ checkedAt: "2026-01-01T00:00:00.000Z" }),
        makeCapabilities({ checkedAt: "2026-01-01T00:05:00.000Z" }),
      ),
    ).toBe(true);
    expect(
      sameSessionCapabilities(
        makeCapabilities({ generation: 1 }),
        makeCapabilities({ generation: 2 }),
      ),
    ).toBe(false);
  });
});
