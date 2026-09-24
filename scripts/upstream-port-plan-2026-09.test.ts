import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makeAudit, sha256, validateAudit, type Ledger } from "./upstream-port-ledger.ts";
import { applyPortPlan, type PortPlan } from "./upstream-port-plan.ts";

const plan = JSON.parse(
  readFileSync(new URL("./upstream-port-plan-2026-09.json", import.meta.url), "utf8"),
) as PortPlan;
const ledger = JSON.parse(
  readFileSync(new URL("./upstream-ports.json", import.meta.url), "utf8"),
) as Ledger;
const allRecords = [...ledger.entries, ...(ledger.historicalEntries ?? [])];
const recordsBySha = new Map(allRecords.map((entry) => [entry.upstreamSha, entry]));
const commits = plan.entries.map((entry) => ({
  sha: entry.upstreamSha,
  subject: recordsBySha.get(entry.upstreamSha)?.subject ?? "Missing ledger record",
}));

describe("September 2026 port classification artifact", () => {
  it("covers the independently pinned 1,836-SHA first-parent interval in order", () => {
    expect(plan.baseSha).toBe("9fd788b5a92254a2afa72c2a53513ed2cb730f0d");
    expect(plan.targetSha).toBe("f5ef0ddb90a8c36584e181b1913e7b8a5df30ffc");
    expect(commits).toHaveLength(1836);
    expect(new Set(commits.map((commit) => commit.sha)).size).toBe(1836);
    // Independently obtained from git rev-list --first-parent base..target.
    expect(sha256(commits.map((commit) => commit.sha).join("\n") + "\n")).toBe(
      "1c3e22afe6a0fb44248d6148f254602a1cb19a3e6bd0bb573caa1afd01def3d8",
    );
    expect(ledger.audit).toEqual(
      makeAudit(
        plan.baseSha,
        plan.targetSha,
        commits.map((commit) => commit.sha),
      ),
    );
    expect(validateAudit(ledger)).toEqual([]);
  });

  it("reapplies the real decisions without changing the ledger or older proof", () => {
    expect(applyPortPlan(ledger, commits, plan)).toEqual(ledger);
    const audited = new Set(commits.map((commit) => commit.sha));
    const legacy = allRecords.filter((entry) => !audited.has(entry.upstreamSha));
    expect(legacy).toHaveLength(486);
    expect(legacy.every((entry) => entry.reviewStatus === "legacy")).toBe(true);
  });

  it("rejects a deleted classification, including one outside the 500-commit window", () => {
    const removed = plan.entries[1000]!;
    expect(() =>
      applyPortPlan(ledger, commits, {
        ...plan,
        entries: plan.entries.filter((entry) => entry !== removed),
      }),
    ).toThrow(`missing SHAs: ${removed.upstreamSha}`);
  });

  it("assigns the two added UX decisions to their approved workstreams", () => {
    for (const [prefix, workstream] of [
      ["8d7c700c1", "3f"],
      ["6f00d3881", "3e"],
    ] as const) {
      const decision = plan.entries.find((entry) => entry.upstreamSha.startsWith(prefix));
      expect(decision).toMatchObject({
        classification: `planned:${workstream}`,
        reviewStatus: "reviewed",
      });
    }
  });
});
