import { describe, expect, it } from "vitest";
import type { ClaudeLimitResetGrant } from "@t3tools/contracts";

import { claudeGrantDescription } from "./ClaudeLimitResets";

describe("Claude reset confirmation", () => {
  it("explains that a Fable grant does not reset the whole week", () => {
    const grant: ClaudeLimitResetGrant = {
      id: "fable",
      label: "Fable reset",
      kind: "fable",
      resetsLeft: 1,
      resetsTotal: 1,
      endsAt: null,
      usableNow: true,
      useRequiresLimit: false,
      givesBackWeekly: true,
      paused: false,
      clears: ["seven_day"],
      blocking: [],
      unavailableReason: null,
    };
    const description = claudeGrantDescription(grant, "Personal");
    expect(description).toContain("Fable reset for Personal");
    expect(description).toContain("gives back what Fable used on your weekly limit");
    expect(description).toContain("doesn't reset your whole week");
    expect(description).not.toContain("It clears the weekly limit");
  });
});
