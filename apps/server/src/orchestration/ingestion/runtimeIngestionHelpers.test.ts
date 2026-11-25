import { ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  contextTokensDispatchThreshold,
  providerTurnKey,
  reasoningStatusActivityId,
  sameSessionCapabilities,
} from "./runtimeIngestionHelpers.ts";

describe("runtimeIngestionHelpers", () => {
  it("computes context token dispatch thresholds and deterministic turn/activity keys", () => {
    expect(contextTokensDispatchThreshold(null)).toBe(2_000);
    expect(contextTokensDispatchThreshold(1_000_000)).toBe(10_000);
    expect(providerTurnKey(ThreadId.make("t1"), TurnId.make("turn-1"))).toBe("t1:turn-1");
    expect(reasoningStatusActivityId(ThreadId.make("t1"), TurnId.make("turn-1"))).toBe(
      reasoningStatusActivityId(ThreadId.make("t1"), TurnId.make("turn-1")),
    );
  });

  it("compares provider session capabilities structurally", () => {
    expect(
      sameSessionCapabilities(
        { generation: 1, actions: [] } as never,
        { generation: 1, actions: [] } as never,
      ),
    ).toBe(true);
    expect(
      sameSessionCapabilities(
        { generation: 1, actions: [] } as never,
        { generation: 2, actions: [] } as never,
      ),
    ).toBe(false);
  });
});
