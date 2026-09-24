import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendInterval,
  makeAudit,
  makeCoverage,
  sortEntries,
  validateAudit,
  type Ledger,
} from "./upstream-port-ledger.ts";
import { parseLedger, validateLedger, validateProvenance } from "./upstream-port-validation.ts";
import { selectRefreshHead, newCommitsSince, UPSTREAM_MAIN_REF } from "./upstream-port-history.ts";
import { applyPortPlan, type PortPlan } from "./upstream-port-plan.ts";
import { classifyCommit } from "./upstream-port-suggestions.ts";
import {
  ROOT,
  entry,
  fixtureLedger,
  repository,
  runCheck,
  sha,
} from "./upstream-port-test-fixtures.ts";

const directories: string[] = [];
afterEach(() => {
  for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true });
});
const repo = (count?: number) => {
  const r = repository(count);
  directories.push(r.directory);
  return r;
};
function fixtureHistory() {
  let main = sha(600);
  return vi.fn((args: ReadonlyArray<string>) => {
    if (args[0] === "remote") return "https://github.com/pingdotgg/t3code.git";
    if (args[0] === "fetch") return "";
    if (args[0] === "rev-parse") {
      const head = main;
      main = sha(601);
      return head;
    }
    if (args[0] === "rev-list")
      return Array.from({ length: parseInt(args[2]!, 16) }, (_, n) =>
        sha(parseInt(args[2]!, 16) - n),
      ).join("\n");
    throw new Error(`unexpected git: ${args}`);
  });
}
describe("pinned refresh", () => {
  it("anchors selection once even when the remote advances", () => {
    const git = fixtureHistory();
    expect(selectRefreshHead(git)).toBe(sha(600));
    expect(git).toHaveBeenCalledWith(["rev-list", "--first-parent", sha(600)]);
    expect(git).toHaveBeenCalledWith([
      "fetch",
      "--no-prune",
      "--no-tags",
      "upstream",
      `refs/heads/main:${UPSTREAM_MAIN_REF}`,
    ]);
    expect(git.mock.calls.filter(([args]) => args[0] === "rev-parse")).toHaveLength(1);
    expect(selectRefreshHead(fixtureHistory(), sha(550))).toBe(sha(550));
  });
  it.each(["HEAD", "abc123", "--help", "x".repeat(40)])(
    "rejects malformed pin %s before fetching",
    (pin) => {
      const git = fixtureHistory();
      expect(() => selectRefreshHead(git, pin)).toThrow("full 40-character SHA");
      expect(git).not.toHaveBeenCalled();
    },
  );
  it("rejects unreachable pins and untrusted remotes", () => {
    expect(() => selectRefreshHead(fixtureHistory(), sha(999))).toThrow("first-parent ancestry");
    const git = vi.fn(() => "https://github.com/other/repo.git");
    expect(() => selectRefreshHead(git)).toThrow("not authoritative");
    expect(git).toHaveBeenCalledTimes(1);
  });
  it.each(["refs/tags/upstream/main", "refs/heads/upstream/main"])(
    "ignores ambiguous %s",
    (shadow) => {
      const r = repo();
      r.git(["update-ref", shadow, r.commits.at(-1)!.sha]);
      const git = (args: ReadonlyArray<string>) => (args[0] === "fetch" ? "" : r.git(args));
      expect(selectRefreshHead(git)).toBe(r.commits[0]!.sha);
    },
  );
  it("adds only the uncovered delta and treats repeated and older pins as no-ops", () => {
    const r = repo(5);
    const head = r.commits[0]!.sha;
    const tracked = r.commits[2]!.sha;
    expect(newCommitsSince(r.git, tracked, head)).toEqual(r.commits.slice(0, 2));
    expect(newCommitsSince(r.git, head, head)).toEqual([]);
    expect(newCommitsSince(r.git, head, tracked)).toEqual([]);
    const tree = r.git(["rev-parse", `${head}^{tree}`]);
    const fork = r.git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit-tree",
      tree,
      "-m",
      "fork",
    ]);
    expect(() => newCommitsSince(r.git, tracked, fork)).toThrow("diverges");
  });
  it("appends without rewriting proof and forces suggestions to remain pending", () => {
    const old = fixtureLedger();
    const next = appendInterval(old, [{ sha: sha(3), subject: "new" }], () => ({
      ...entry(3),
      reviewStatus: "reviewed",
    }));
    expect(next.entries.slice(0, 2)).toEqual(old.entries);
    expect(next.entries[2]?.reviewStatus).toBe("pending");
    expect(next.intervals[1]?.baseSha).toBe(sha(2));
    expect(validateLedger(next, ROOT).join("\n")).toContain("requires review");
    expect(appendInterval(next, [], classifyCommit)).toBe(next);
    expect(() =>
      appendInterval(next, [{ sha: sha(2), subject: "existing" }], classifyCommit),
    ).toThrow("overlaps");
  });
});
describe("coverage and decisions", () => {
  it("validates sorted records and contiguous intervals", () => {
    expect(validateLedger(fixtureLedger(), ROOT)).toEqual([]);
  });
  it.each([
    ["missing", (l: Ledger) => ({ ...l, entries: l.entries.slice(1) }), "missing ledger SHA"],
    [
      "extra legacy",
      (l: Ledger) => ({
        ...l,
        entries: [...l.entries, { ...entry(9), reviewStatus: "legacy" as const }],
      }),
      "extra ledger SHA",
    ],
    [
      "duplicate records",
      (l: Ledger) => ({ ...l, entries: [...l.entries, l.entries[0]!] }),
      "duplicate ledger SHA",
    ],
    [
      "overlap",
      (l: Ledger) => ({ ...l, legacyCoverage: makeCoverage([sha(1)]) }),
      "duplicate coverage SHA",
    ],
    [
      "gap",
      (l: Ledger) => ({ ...l, intervals: [...l.intervals, makeAudit(sha(9), sha(4), [sha(4)])] }),
      "not contiguous",
    ],
    [
      "digest",
      (l: Ledger) => ({ ...l, intervals: [{ ...l.intervals[0]!, digest: "0".repeat(64) }] }),
      "digest",
    ],
    [
      "count",
      (l: Ledger) => ({ ...l, legacyCoverage: { ...l.legacyCoverage, count: 1 } }),
      "count",
    ],
    ["order", (l: Ledger) => ({ ...l, entries: [...l.entries].reverse() }), "sorted"],
  ] as const)("rejects %s", (_name, mutate, message) => {
    expect(validateAudit(mutate(fixtureLedger())).join("\n")).toContain(message);
  });
  it.each([
    "apps/server/src/main.ts",
    "apps/server/src/missing.ts:1",
    "apps/server/src/main.ts:999999",
    "../outside.ts:1",
  ])("rejects invalid evidence %s", (evidence) => {
    const l = fixtureLedger();
    const bad = {
      ...l,
      entries: [
        {
          ...entry(1),
          disposition: "equivalent" as const,
          f5Shas: [sha(44)],
          evidence: [evidence],
        },
        entry(2),
      ],
    };
    expect(validateLedger(bad, ROOT).join("\n")).toContain("evidence");
  });
  it("does not require historical f5 proof commits to remain resolvable after squash merges", () => {
    expect(
      validateLedger(
        {
          ...fixtureLedger(),
          entries: [{ ...entry(1), disposition: "ported", f5Shas: [sha(999)] }, entry(2)],
        },
        ROOT,
      ),
    ).toEqual([]);
  });
  it("rejects malformed shapes without traversing invalid arrays", () => {
    expect(() => parseLedger('{"schemaVersion":6,"entries":null}')).toThrow("malformed");
    expect(() => parseLedger('{"schemaVersion":5}')).toThrow("--migrate");
    expect(() =>
      parseLedger(JSON.stringify({ ...fixtureLedger(), historicalEntries: [] })),
    ).toThrow("obsolete");
  });
  it("rejects an interval on a fork, despite internally matching coverage", () => {
    const r = repo();
    const tree = r.git(["rev-parse", `${r.commits[0]!.sha}^{tree}`]);
    const fork = r.git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit-tree",
      tree,
      "-p",
      r.commits.at(-1)!.sha,
      "-m",
      "fork",
    ]);
    const ledger = {
      ...r.ledger,
      entries: [{ ...entry(1), upstreamSha: fork, subject: "fork" }],
      intervals: [makeAudit(r.commits.at(-1)!.sha, fork, [fork])],
    };
    expect(() => validateProvenance(ledger, r.git)).toThrow("first-parent ancestry");
  });
  it("requires legacy reachability, not merely an existing commit object", () => {
    const r = repo();
    const tree = r.git(["rev-parse", `${r.commits[0]!.sha}^{tree}`]);
    const fork = r.git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit-tree",
      tree,
      "-m",
      "fork",
    ]);
    const ledger = {
      ...r.ledger,
      entries: sortEntries([
        ...r.ledger.entries,
        { ...entry(1), upstreamSha: fork, subject: "fork", reviewStatus: "legacy" as const },
      ]),
      legacyCoverage: makeCoverage([fork]),
    };
    expect(() => validateProvenance(ledger, r.git)).toThrow("not reachable");
  });
});
describe("classification within existing history", () => {
  const old = fixtureLedger();
  const commits = [2, 1].map((n) => ({ sha: sha(n), subject: entry(n).subject }));
  const plan: PortPlan = {
    schemaVersion: 1,
    baseSha: sha(0),
    targetSha: sha(2),
    entries: commits.map((c) => ({
      upstreamSha: c.sha,
      classification: "planned:7b",
      reason: "Generic attachments approved for Phase 7b.",
      reviewStatus: "reviewed",
    })),
  };
  it("reapplies an older plan after a later refresh without changing coverage", () => {
    const extended = appendInterval(old, [{ sha: sha(3), subject: "new" }], classifyCommit);
    const applied = applyPortPlan(extended, commits, plan);
    expect(applied.intervals).toEqual(extended.intervals);
    expect(applied.entries.at(-1)).toEqual(extended.entries.at(-1));
    expect(applyPortPlan(applied, commits, plan)).toEqual(applied);
  });
  it("accepts substantive reasons that mention manual assessment or pending review", () => {
    for (const reason of [
      "Declined after manual accessibility assessment.",
      "Deferred pending review of the optional capture dependency license.",
    ]) {
      const applied = applyPortPlan(old, commits, {
        ...plan,
        entries: plan.entries.map((e) => ({ ...e, reason })),
      });
      expect(validateLedger(applied, ROOT)).toEqual([]);
    }
  });
  it("allows a contiguous plan spanning two discovery intervals", () => {
    const extended = appendInterval(old, [{ sha: sha(3), subject: "new" }], classifyCommit);
    const selected = [{ sha: sha(3), subject: "new" }, commits[0]!];
    const spanning: PortPlan = {
      ...plan,
      baseSha: sha(1),
      targetSha: sha(3),
      entries: selected.map((c) => ({ ...plan.entries[0]!, upstreamSha: c.sha })),
    };
    const applied = applyPortPlan(extended, selected, spanning);
    expect(applied.entries[0]).toEqual(old.entries[0]);
    expect(
      applied.entries
        .slice(1)
        .every((e) => e.plannedWorkstream === "7b" && e.reviewStatus === "reviewed"),
    ).toBe(true);
    expect(applied.intervals).toEqual(extended.intervals);
  });
  it.each(["ported", "equivalent", "already-present"] as const)(
    "preserves %s unchanged",
    (disposition) => {
      const proof = {
        ...entry(1),
        disposition,
        evidence: ["apps/server/src/main.ts:1"],
        f5Shas: [sha(55)],
      };
      const applied = applyPortPlan({ ...old, entries: [proof, entry(2)] }, commits, plan);
      expect(applied.entries[0]).toEqual(proof);
      expect(applied.entries[0]?.plannedWorkstream).toBeUndefined();
    },
  );
  it("rejects missing, extra and duplicate classifications", () => {
    expect(() => applyPortPlan(old, commits, { ...plan, entries: plan.entries.slice(1) })).toThrow(
      "missing SHAs",
    );
    expect(() =>
      applyPortPlan(old, commits, {
        ...plan,
        entries: [...plan.entries, { ...plan.entries[0]!, upstreamSha: sha(9) }],
      }),
    ).toThrow("extra SHAs");
    expect(() =>
      applyPortPlan(old, commits, { ...plan, entries: [...plan.entries, plan.entries[0]!] }),
    ).toThrow("duplicate classification");
  });
  it("cannot widen coverage or substitute commits for the selected interval", () => {
    expect(() => applyPortPlan(old, commits, { ...plan, targetSha: sha(9) })).toThrow(
      "already-covered",
    );
    expect(() => applyPortPlan(old, commits.slice(0, 1), plan)).toThrow("selection differs");
    expect(() =>
      applyPortPlan(old, commits, {
        ...plan,
        entries: plan.entries.map((e) => ({
          ...e,
          reason: "Requires manual f5-native user-impact assessment.",
        })),
      }),
    ).toThrow("concrete reason");
  });
});
describe("read-only CLI", () => {
  it("ignores obsolete manifests, journals, malformed locks and temp files", () => {
    const r = repo();
    const before = readFileSync(r.file, "utf8");
    writeFileSync(`${r.file}.lock`, "");
    writeFileSync(`${r.file}.tmp-interrupted`, "partial");
    writeFileSync(`${r.file}.refresh-journal`, "truncated");
    const result = runCheck(r.directory, r.file);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(r.file, "utf8")).toBe(before);
    expect(readFileSync(`${r.file}.lock`, "utf8")).toBe("");
  });
  it("does not migrate implicitly and rejects invalid command combinations", () => {
    const r = repo();
    expect(runCheck(r.directory, r.file, ["--head", sha(1)]).stderr).toContain(
      "--head requires --refresh",
    );
    expect(runCheck(r.directory, r.file, ["--refresh", "--migrate"]).status).toBe(1);
    writeFileSync(r.file, '{"schemaVersion":5}');
    expect(runCheck(r.directory, r.file).stderr).toContain("--migrate");
    expect(readFileSync(r.file, "utf8")).toBe('{"schemaVersion":5}');
  });
});
