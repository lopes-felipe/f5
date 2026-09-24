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
const allRecords = ledger.entries;
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
    expect(ledger.intervals[0]).toEqual(
      makeAudit(
        plan.baseSha,
        plan.targetSha,
        commits.map((commit) => commit.sha),
      ),
    );
    expect(validateAudit(ledger)).toEqual([]);
  });

  it("reapplies the original review while preserving completed ports and older proof", () => {
    const reapplied = applyPortPlan(ledger, commits, plan);
    const reappliedBySha = new Map(reapplied.entries.map((entry) => [entry.upstreamSha, entry]));
    // The artifact is the original review. Later implementation reviews can
    // legitimately revise non-port decisions; completed proof must survive.
    for (const entry of ledger.entries) {
      if (
        entry.reviewStatus === "legacy" ||
        ["ported", "equivalent", "already-present"].includes(entry.disposition)
      ) {
        expect(reappliedBySha.get(entry.upstreamSha)).toEqual(entry);
      }
    }
    expect(reapplied.intervals).toEqual(ledger.intervals);
    expect(reapplied.legacyCoverage).toEqual(ledger.legacyCoverage);
    const legacyShas = new Set(ledger.legacyCoverage.upstreamShas);
    const legacy = allRecords.filter((entry) => legacyShas.has(entry.upstreamSha));
    expect(legacy).toHaveLength(496);
    expect(legacy.every((entry) => entry.reviewStatus === "legacy")).toBe(true);
  });

  it("rejects a deleted classification, including a decision deep inside the interval", () => {
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
