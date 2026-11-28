import { describe, expect, it } from "vitest";
import type { ClaudeLimitResetGrant } from "@t3tools/contracts";
import type { QuotaWindow } from "@t3tools/shared/usageLimit";

import { claudeGrantDescription, claudeResetsLinkPlacement } from "./ClaudeLimitResets";

describe("claudeResetsLinkPlacement", () => {
  const NOW = Date.parse("2026-11-28T12:00:00.000Z");
  const later = new Date(NOW + 3_600_000).toISOString();
  const earlier = new Date(NOW - 60_000).toISOString();
  const window = (windowKey: string, usedPercent: number, resetsAt = later): QuotaWindow => ({
    windowKey,
    label: windowKey,
    usedPercent,
    resetsAt,
    durationMinutes: null,
  });
  const withheld = {
    subscriptionLabel: "Max",
    limitsAvailable: true,
    limitResets: null,
    limitResetsWithheld: true,
  };

  it("shows only after Claude said it withholds resets from F5", () => {
    const windows = [window("five_hour", 20), window("seven_day", 40)];
    expect(claudeResetsLinkPlacement(withheld, windows, NOW)).toBe("row");
    // Failed, unsupported or older reads leave the flag off or absent.
    expect(
      claudeResetsLinkPlacement({ ...withheld, limitResetsWithheld: false }, windows, NOW),
    ).toBe(null);
    const { limitResetsWithheld: _absent, ...older } = withheld;
    expect(claudeResetsLinkPlacement(older, windows, NOW)).toBe(null);
    expect(claudeResetsLinkPlacement({ ...withheld, limitsAvailable: false }, windows, NOW)).toBe(
      null,
    );
    expect(claudeResetsLinkPlacement({ ...withheld, subscriptionLabel: null }, windows, NOW)).toBe(
      null,
    );
    expect(
      claudeResetsLinkPlacement(
        { ...withheld, limitResets: { grants: [], nextGrantId: null, cooldownUntil: null } },
        windows,
        NOW,
      ),
    ).toBe(null);
  });

  it("joins the callout only while two live windows compete and the tightest is exhausted", () => {
    expect(
      claudeResetsLinkPlacement(withheld, [window("five_hour", 100), window("seven_day", 40)], NOW),
    ).toBe("callout");
    // A single live window has no callout, so the link keeps its row.
    expect(claudeResetsLinkPlacement(withheld, [window("five_hour", 100)], NOW)).toBe("row");
    // An exhausted window whose reset has passed no longer competes.
    expect(
      claudeResetsLinkPlacement(
        withheld,
        [window("five_hour", 100, earlier), window("seven_day", 40), window("seven_day_opus", 10)],
        NOW,
      ),
    ).toBe("row");
    // Spend-only accounts have no plan windows at all.
    expect(claudeResetsLinkPlacement(withheld, [], NOW)).toBe("row");
  });
});

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
    expect(
      claudeGrantDescription({ ...grant, kind: "weekly", label: "Weekly reset" }, "Personal"),
    ).toContain("one Fable reset for Personal");
  });
});
