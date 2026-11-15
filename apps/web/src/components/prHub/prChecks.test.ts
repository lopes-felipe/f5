import type { PrHubCheck, PrHubCheckStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { groupPrChecks, prCheckStatusLabel, prChecksSummary } from "./prChecks";

const check = (name: string, status: PrHubCheckStatus, required?: boolean): PrHubCheck => ({
  name,
  status,
  description: null,
  url: null,
  ...(required === undefined ? {} : { required }),
});

describe("groupPrChecks", () => {
  it("puts failed checks first, then running, passed and skipped, and drops empty groups", () => {
    const groups = groupPrChecks([
      check("lint", "success"),
      check("docs", "skipped"),
      check("build", "failure"),
      check("deploy", "cancelled"),
      check("e2e", "pending"),
      check("advisory", "neutral"),
    ]);
    expect(groups.map((group) => [group.id, group.checks.map((item) => item.name)])).toEqual([
      ["failed", ["build", "deploy"]],
      ["running", ["e2e"]],
      ["passed", ["lint"]],
      ["skipped", ["advisory", "docs"]],
    ]);
    expect(groupPrChecks([check("lint", "success")]).map((group) => group.id)).toEqual(["passed"]);
    expect(groupPrChecks([])).toEqual([]);
  });

  it("lists required checks before the others in a group", () => {
    const [failed] = groupPrChecks([
      check("alpha", "failure"),
      check("zeta", "failure", true),
      check("beta", "failure", false),
    ]);
    expect(failed?.checks.map((item) => item.name)).toEqual(["zeta", "alpha", "beta"]);
  });
});

describe("check presentation", () => {
  it("names each status", () => {
    expect(prCheckStatusLabel("cancelled")).toBe("Cancelled");
    expect(prCheckStatusLabel("pending")).toBe("Running");
    expect(prCheckStatusLabel("neutral")).toBe("Neutral");
  });

  it("summarizes the groups in one line", () => {
    expect(
      prChecksSummary([
        check("build", "failure"),
        check("e2e", "pending"),
        check("lint", "success"),
        check("unit", "success"),
      ]),
    ).toBe("1 failed, 1 running, 2 passed");
    expect(prChecksSummary([])).toBe("");
  });
});
