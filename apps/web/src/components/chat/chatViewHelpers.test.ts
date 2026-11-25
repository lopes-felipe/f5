import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  deriveFallbackTasksFromPlan,
  extendReplacementRangeForTrailingSpace,
  providerKindForDriver,
  summarizeTaskCounts,
} from "./chatViewHelpers";

describe("chatViewHelpers", () => {
  it("extends replacement range over a single trailing space and maps drivers to provider kinds", () => {
    expect(extendReplacementRangeForTrailingSpace("hello world", 5, "@file ")).toBe(6);
    expect(extendReplacementRangeForTrailingSpace("hello", 5, "@file ")).toBe(5);
    expect(extendReplacementRangeForTrailingSpace("hello world", 5, "@file")).toBe(5);
    expect(providerKindForDriver(ProviderDriverKind.make("codex"))).toBe("codex");
    expect(providerKindForDriver(ProviderDriverKind.make("claudeAgent"))).toBe("claudeAgent");
    expect(providerKindForDriver(ProviderDriverKind.make("acp"))).toBeNull();
  });

  it("summarizes task counts and derives fallback tasks from active plan steps", () => {
    const tasks = deriveFallbackTasksFromPlan({
      createdAt: "2026-01-01T00:00:00.000Z",
      turnId: null,
      explanation: null,
      steps: [
        { step: "Done step", status: "completed" },
        { step: "Working step", status: "inProgress" },
        { step: "Pending step", status: "pending" },
      ],
    });
    expect(tasks).toHaveLength(3);
    expect(summarizeTaskCounts(tasks)).toBe("1 active · 1 pending · 1 done");
  });
});
