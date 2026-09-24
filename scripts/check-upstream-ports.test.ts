import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { classifyCommit } from "./upstream-port-suggestions.ts";
import {
  makeAudit,
  refreshEntries,
  sha256,
  validateAudit,
  type FrozenCommit,
  type Ledger,
  type LedgerEntry,
} from "./upstream-port-ledger.ts";
import { selectRefreshHead, UPSTREAM_MAIN_REF } from "./upstream-port-history.ts";
import { applyPortPlan, type PortPlan } from "./upstream-port-plan.ts";
import { readPortFiles, recoverPortFiles, writePortFiles } from "./upstream-port-files.ts";

import { afterEach, describe, expect, it, vi } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "check-upstream-ports.ts");
const sourceManifestText = readFileSync(
  path.join(ROOT, "scripts", "upstream-ports.manifest.json"),
  "utf8",
);
const sourceManifest = JSON.parse(sourceManifestText) as Record<string, unknown>;
const sourceLedger = JSON.parse(
  readFileSync(path.join(ROOT, "scripts", "upstream-ports.json"), "utf8"),
) as {
  manifestSha256: string;
  entries: Array<Record<string, unknown>>;
};

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runWith(ledger: unknown, args: string[] = []): ReturnType<typeof spawnSync> {
  const directory = mkdtempSync(path.join(tmpdir(), "f5-upstream-ports-test-"));
  temporaryDirectories.push(directory);
  const manifestPath = path.join(directory, "manifest.json");
  const ledgerPath = path.join(directory, "ledger.json");
  writeFileSync(manifestPath, sourceManifestText);
  writeFileSync(ledgerPath, JSON.stringify(ledger));
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      CI: "1",
      F5_UPSTREAM_PORTS_MANIFEST_PATH: manifestPath,
      F5_UPSTREAM_PORTS_LEDGER_PATH: ledgerPath,
    },
  });
}

function runRaw(manifest: string, ledger: string): ReturnType<typeof spawnSync> {
  const directory = mkdtempSync(path.join(tmpdir(), "f5-upstream-ports-test-"));
  temporaryDirectories.push(directory);
  const manifestPath = path.join(directory, "manifest.json");
  const ledgerPath = path.join(directory, "ledger.json");
  writeFileSync(manifestPath, manifest);
  writeFileSync(ledgerPath, ledger);
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      CI: "1",
      F5_UPSTREAM_PORTS_MANIFEST_PATH: manifestPath,
      F5_UPSTREAM_PORTS_LEDGER_PATH: ledgerPath,
    },
  });
}

describe("check-upstream-ports", () => {
  it("rejects a malformed disposition row", () => {
    const ledger = structuredClone(sourceLedger);
    ledger.entries[0]!.disposition = "maybe";

    const result = runWith(ledger);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("invalid disposition maybe");
  }, 15_000);

  it("allows historical implementation SHAs that a squash merge may no longer resolve", () => {
    const ledger = structuredClone(sourceLedger);
    ledger.entries[0]!.disposition = "ported";
    ledger.entries[0]!.f5Shas = ["0000000000000000000000000000000000000000"];
    delete ledger.entries[0]!.reason;

    const result = runWith(ledger);

    expect(result.status, String(result.stderr)).toBe(0);
  }, 15_000);

  it.each([
    ["malformed", ["apps/server/src/main.ts"]],
    ["missing", ["apps/server/src/does-not-exist.ts:1"]],
    ["out of range", ["apps/server/src/main.ts:9999999"]],
    ["outside the repository", ["../outside.ts:1"]],
  ])(
    "rejects %s already-present evidence",
    (_label, evidence) => {
      const ledger = structuredClone(sourceLedger);
      // The frozen window can advance past every existing already-present row.
      const entry = ledger.entries[0]!;
      entry.disposition = "already-present";
      entry.evidence = evidence;

      const result = runWith(ledger);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("evidence");
    },
    15_000,
  );

  it("rejects a generic manual-assessment reason even when labeled reviewed", () => {
    const ledger = structuredClone(sourceLedger);
    ledger.entries[0]!.reviewStatus = "reviewed";
    ledger.entries[0]!.reason = "Requires manual f5-native user-impact assessment.";
    const result = runWith(ledger);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requires review");
  }, 15_000);

  it("reports malformed JSON without an uncaught type error", () => {
    const result = runRaw(JSON.stringify(sourceManifest), '{"schemaVersion":3,"entries":');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not parse");
    expect(result.stderr).not.toContain("is not iterable");
  }, 15_000);

  it("rejects a manifest changed without updating its integrity digest", () => {
    const manifest = structuredClone(sourceManifest);
    manifest.selection = {
      ...(manifest.selection as Record<string, unknown>),
      boundarySha: "0000000000000000000000000000000000000000",
    };
    const result = runRaw(JSON.stringify(manifest), JSON.stringify(sourceLedger));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("integrity digest");
  }, 15_000);
});

// Pure selection/migration tests deliberately avoid live network access. The CLI
// provenance check above still compares the checked-in data with real Git history.
const sha = (n: number) => n.toString(16).padStart(40, "0");
const commit = (n: number): FrozenCommit => ({ sha: sha(n), subject: `Fixture ${n}` });
const entry = (n: number): LedgerEntry => ({
  upstreamSha: sha(n),
  subject: `Fixture ${n}`,
  disposition: "deferred",
  reason: "Attachment ownership must land first.",
  reviewStatus: "reviewed",
  plannedWorkstream: "7b",
});
const fixtureLedger = (entries: ReadonlyArray<LedgerEntry>): Ledger => ({
  schemaVersion: 5,
  manifest: "scripts/upstream-ports.manifest.json",
  manifestSha256: sha256("fixture"),
  entries,
  historicalEntries: [],
  olderBacklog: [],
});
const suggestion = (value: FrozenCommit): LedgerEntry => ({
  upstreamSha: value.sha,
  subject: value.subject,
  disposition: "deferred",
  reason: "Requires manual f5-native user-impact assessment.",
  reviewStatus: "pending",
});

function fixtureHistory() {
  let main = sha(600);
  const run = vi.fn((args: ReadonlyArray<string>) => {
    if (args[0] === "remote") return "https://github.com/pingdotgg/t3code.git";
    if (args[0] === "fetch") return "";
    if (args[0] === "rev-parse") {
      const captured = main;
      main = sha(601);
      return captured;
    }
    if (args[0] === "rev-list")
      return Array.from({ length: Number.parseInt(args[2]!, 16) }, (_, index) =>
        sha(Number.parseInt(args[2]!, 16) - index),
      ).join("\n");
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  });
  return run;
}

describe("pinned upstream refresh", () => {
  it("anchors plain refresh to the fetched head even if upstream/main advances", () => {
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
  });
  it("selects the exact older pin after a moving-head fetch", () => {
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
  it("rejects unreachable and non-first-parent pins", () => {
    expect(() => selectRefreshHead(fixtureHistory(), sha(999))).toThrow("first-parent ancestry");
  });
  it("rejects an untrusted remote before fetching", () => {
    const git = vi.fn(() => "https://github.com/other/repository.git");
    expect(() => selectRefreshHead(git)).toThrow("not authoritative");
    expect(git).toHaveBeenCalledTimes(1);
  });
  it("leaves both files intact when the CLI receives an invalid refresh pin", () => {
    const result = runWith(sourceLedger, ["--refresh", "--head", "not-a-full-sha"]);
    const directory = temporaryDirectories.at(-1)!;
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("full 40-character SHA");
    expect(readFileSync(path.join(directory, "manifest.json"), "utf8")).toBe(sourceManifestText);
    expect(JSON.parse(readFileSync(path.join(directory, "ledger.json"), "utf8"))).toEqual(
      sourceLedger,
    );
  });
  it("rejects a --head argument outside refresh", () => {
    const result = runWith(sourceLedger, ["--head", sha(600)]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--head requires --refresh");
  });
});

describe("schema 5 history", () => {
  it("preserves reasons, evidence, implementation SHAs and workstreams individually", () => {
    const first = {
      ...entry(1),
      disposition: "ported" as const,
      f5Shas: [sha(900)],
      evidence: ["AGENTS.md:1"],
    };
    const second = { ...entry(2), reason: "Waiting on provider support; not a Deferred prefix." };
    const before = fixtureLedger([first, second]);
    const after = refreshEntries(before, [commit(3)], suggestion);
    expect(after.historicalEntries).toEqual([first, second]);
    expect(after.olderBacklog).toEqual([]);
    expect(after.entries[0]?.reviewStatus).toBe("pending");
  });
  it("migrates schema 4 without manufacturing review approval and is idempotent", () => {
    const { reviewStatus: _reviewStatus, ...old } = entry(1);
    const legacy: Ledger = { ...fixtureLedger([old]), schemaVersion: 4 };
    const updated = {
      ...legacy,
      schemaVersion: 5 as const,
      ...refreshEntries(legacy, [commit(1)], suggestion),
    };
    expect(updated.entries[0]).toMatchObject({ ...old, reviewStatus: "legacy" });
    const roundTrip = JSON.parse(JSON.stringify(updated)) as Ledger;
    expect(refreshEntries(roundTrip, [commit(1)], suggestion)).toEqual({
      entries: roundTrip.entries,
      historicalEntries: [],
      olderBacklog: [],
    });
  });
  it("brings a historical record back into a pinned window without losing its decision", () => {
    const previous = { ...fixtureLedger([entry(2)]), historicalEntries: [entry(1)] };
    const next = refreshEntries(previous, [commit(1)], suggestion);
    expect(next.entries).toEqual([entry(1)]);
    expect(next.historicalEntries).toEqual([entry(2)]);
    expect(refreshEntries({ ...previous, ...next }, [commit(1)], suggestion)).toEqual(next);
  });
  it("keeps category provenance when a legacy exact-SHA member moves into the window", () => {
    const category = {
      category: "old-plan",
      selection: "exact",
      disposition: "ported" as const,
      reason: "Implemented in the original port program.",
      upstreamShas: [sha(1)],
      f5Shas: [sha(900)],
    };
    const before = { ...fixtureLedger([]), olderBacklog: [category] };
    const next = refreshEntries(before, [commit(1)], suggestion);
    expect(next.entries[0]).toMatchObject({
      upstreamSha: sha(1),
      disposition: "ported",
      f5Shas: [sha(900)],
      reason: category.reason,
      reviewStatus: "legacy",
    });
    expect(next.olderBacklog).toEqual([
      { ...category, upstreamShas: [], promotedUpstreamShas: [sha(1)] },
    ]);
    expect(refreshEntries({ ...before, ...next }, [commit(1)], suggestion)).toEqual(next);
  });
  it("never marks prefix suggestions as reviewed or completed", () => {
    const planned = classifyCommit({ sha: "fbd77420" + "0".repeat(32), subject: "Fixture" });
    expect(planned).toMatchObject({
      disposition: "deferred",
      reviewStatus: "pending",
      plannedWorkstream: "1.1 four runtime modes",
    });
    expect(classifyCommit({ sha: "acf761b2" + "0".repeat(32), subject: "Fixture" })).toMatchObject({
      disposition: "deferred",
      reviewStatus: "pending",
    });
    expect(classifyCommit(commit(99))).toMatchObject({
      disposition: "deferred",
      reviewStatus: "pending",
    });
  });
  it("rejects duplicate previous records instead of silently selecting a winner", () => {
    expect(() =>
      refreshEntries(fixtureLedger([entry(1), entry(1)]), [commit(1)], suggestion),
    ).toThrow("duplicate SHA");
  });
});

describe("exact-SHA classification coverage", () => {
  const commits = Array.from({ length: 1836 }, (_, index) => commit(1836 - index));
  const plan: PortPlan = {
    schemaVersion: 1,
    baseSha: sha(0),
    targetSha: sha(1836),
    entries: commits.map((value) => ({
      upstreamSha: value.sha,
      classification: "planned:7b",
      reason: "Generic attachments are approved for Phase 7b; implementation is pending.",
      reviewStatus: "reviewed",
    })),
  };
  const before = fixtureLedger(
    commits.slice(0, 500).map((value) => ({ ...suggestion(value), reviewStatus: "pending" })),
  );
  it("requires all 1,836 SHAs and keeps planned work deferred", () => {
    const applied = applyPortPlan(before, commits, plan);
    expect(applied.entries).toHaveLength(500);
    expect(applied.historicalEntries).toHaveLength(1336);
    expect(applied.audit).toEqual(
      makeAudit(
        plan.baseSha,
        plan.targetSha,
        commits.map((value) => value.sha),
      ),
    );
    expect(validateAudit(applied)).toEqual([]);
    expect(
      [...applied.entries, ...applied.historicalEntries!].every(
        (value) => value.disposition === "deferred",
      ),
    ).toBe(true);
    expect(applyPortPlan(applied, commits, plan)).toEqual(applied);
  });
  it("lists both missing and extra SHAs", () => {
    const changed = {
      ...plan,
      entries: [...plan.entries.slice(1), { ...plan.entries[0]!, upstreamSha: sha(9999) }],
    };
    expect(() => applyPortPlan(before, commits, changed)).toThrow(
      `missing SHAs: ${sha(1836)}; extra SHAs: ${sha(9999)}`,
    );
  });
  it("rejects duplicate decisions and generic manual-assessment placeholders", () => {
    expect(() =>
      applyPortPlan(before, commits, { ...plan, entries: [...plan.entries, plan.entries[0]!] }),
    ).toThrow("duplicate classification SHA");
    expect(() =>
      applyPortPlan(before, commits, {
        ...plan,
        entries: plan.entries.map((value) => ({ ...value, reason: "Requires manual assessment" })),
      }),
    ).toThrow("concrete reason");
  });
  it("detects duplicate coverage across records and exact-SHA legacy categories", () => {
    const applied = applyPortPlan(before, commits, plan);
    expect(
      validateAudit({
        ...applied,
        historicalEntries: [...applied.historicalEntries!, applied.entries[0]!],
      }).join("\n"),
    ).toContain("duplicate audit coverage SHA");
    expect(
      validateAudit({
        ...applied,
        olderBacklog: [
          {
            category: "legacy",
            selection: "exact",
            disposition: "deferred",
            reason: "Legacy provenance",
            upstreamShas: [sha(1836)],
          },
        ],
      }).join("\n"),
    ).toContain("duplicate audit coverage SHA");
  });
  it("detects missing and extra records and ordered-digest tampering", () => {
    const applied = applyPortPlan(before, commits, plan);
    expect(
      validateAudit({ ...applied, entries: [entry(9999), ...applied.entries.slice(1)] }).join("\n"),
    ).toContain(`missing audit SHAs: ${sha(1836)}`);
    expect(
      validateAudit({ ...applied, entries: [entry(9999), ...applied.entries.slice(1)] }).join("\n"),
    ).toContain(`extra audit SHAs: ${sha(9999)}`);
    expect(
      validateAudit({
        ...applied,
        audit: { ...applied.audit!, upstreamShas: [...applied.audit!.upstreamShas].reverse() },
      }).join("\n"),
    ).toContain("audit digest");
  });
  it.each(["ported", "equivalent", "already-present"] as const)(
    "preserves %s proof unchanged when reapplying triage",
    (disposition) => {
      const applied = applyPortPlan(before, commits, plan);
      const completed = {
        ...applied.entries[0]!,
        disposition,
        evidence: ["apps/server/src/main.ts:1"],
        f5Shas: [sha(9000)],
      };
      delete completed.plannedWorkstream;
      expect(
        applyPortPlan(
          { ...applied, entries: [completed, ...applied.entries.slice(1)] },
          commits,
          plan,
        ).entries[0],
      ).toEqual(completed);
    },
  );
});

function filePair() {
  const directory = mkdtempSync(path.join(tmpdir(), "f5-upstream-pair-"));
  temporaryDirectories.push(directory);
  const files = {
    manifest: path.join(directory, "manifest.json"),
    ledger: path.join(directory, "ledger.json"),
  };
  const previous = { manifest: "old manifest\n", ledger: "old ledger\n" };
  writeFileSync(files.manifest, previous.manifest);
  writeFileSync(files.ledger, previous.ledger);
  return { files, previous };
}

describe("interrupted refresh publication", () => {
  const next = { manifest: "new manifest\n", ledger: "new ledger\n" };
  it("rolls back an exception between the two renames", () => {
    const { files, previous } = filePair();
    expect(() =>
      writePortFiles(files, previous, next, () => {
        throw new Error("interrupted");
      }),
    ).toThrow("interrupted");
    expect(readPortFiles(files)).toEqual(previous);
  });
  it("recovers the exact prior bytes after a writer is killed between renames", () => {
    const { files, previous } = filePair();
    const moduleUrl = pathToFileURL(path.join(ROOT, "scripts/upstream-port-files.ts")).href;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { writePortFiles } from ${JSON.stringify(moduleUrl)}; writePortFiles(${JSON.stringify(files)}, ${JSON.stringify(previous)}, ${JSON.stringify(next)}, () => process.kill(process.pid, 'SIGKILL'));`,
      ],
      { encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(readFileSync(files.manifest, "utf8")).toBe(next.manifest);
    expect(() => readPortFiles(files)).toThrow("validation is read-only");
    recoverPortFiles(files);
    expect(readPortFiles(files)).toEqual(previous);
    expect(readFileSync(files.manifest, "utf8")).toBe(previous.manifest);
    expect(readFileSync(files.ledger, "utf8")).toBe(previous.ledger);
  });
  it("does not expose mixed generations to readers during a live refresh", () => {
    const { files, previous } = filePair();
    writePortFiles(files, previous, next, () => {
      expect(() => readPortFiles(files)).toThrow("validation is read-only");
      expect(() => recoverPortFiles(files)).toThrow("already running");
    });
    expect(readPortFiles(files)).toEqual(next);
  });
  it("preserves concurrent edits instead of overwriting them with a stale snapshot", () => {
    const { files, previous } = filePair();
    writeFileSync(files.ledger, "concurrent decision");
    expect(() => writePortFiles(files, previous, next)).toThrow("ledger changed during refresh");
    expect(readPortFiles(files)).toEqual({ ...previous, ledger: "concurrent decision" });
  });
});

describe("review regressions", () => {
  it.each(["refs/tags/upstream/main", "refs/heads/upstream/main"])(
    "ignores ambiguous %s when selecting a refresh head",
    (shadow) => {
      const directory = mkdtempSync(path.join(tmpdir(), "f5-ref-shadow-"));
      temporaryDirectories.push(directory);
      const git = (args: ReadonlyArray<string>, input?: string) =>
        execFileSync(
          "git",
          ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", ...args],
          { cwd: directory, encoding: "utf8", input },
        ).trim();
      git(["init"]);
      const tree = git(["mktree"], "");
      const upstream = git(["commit-tree", tree, "-m", "upstream"]);
      const fork = git(["commit-tree", tree, "-m", "fork"]);
      git(["update-ref", UPSTREAM_MAIN_REF, upstream]);
      git(["update-ref", shadow, fork]);
      const run = (args: ReadonlyArray<string>) => {
        if (args[0] === "remote") return "https://github.com/pingdotgg/t3code.git";
        if (args[0] === "fetch") return ""; // No network: test actual Git ref resolution.
        return git(args);
      };
      expect(selectRefreshHead(run)).toBe(upstream);
      expect(() => selectRefreshHead(run, fork)).toThrow("first-parent ancestry");
    },
  );

  it("rejects an audit interval from f5 instead of upstream", () => {
    const fork = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
    const base = execFileSync("git", ["rev-parse", "HEAD^1"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
    const ledger = structuredClone(sourceLedger) as unknown as Ledger;
    const result = runWith({
      ...ledger,
      audit: makeAudit(base, fork, [fork]),
      historicalEntries: [
        {
          upstreamSha: fork,
          subject: "fork-only commit",
          disposition: "deferred",
          reviewStatus: "reviewed",
          reason: "Fixture for foreign history rejection.",
        },
      ],
    });
    expect(result.status, String(result.stderr)).toBe(1);
    expect(result.stderr).toContain("audit target is not on upstream/main first-parent ancestry");
  });

  it("rejects a mismatched pair before refresh can fetch or publish", () => {
    const result = runWith({ ...sourceLedger, manifestSha256: "0".repeat(64) }, ["--refresh"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("manifest/ledger integrity mismatch");
    const directory = temporaryDirectories.at(-1)!;
    expect(readFileSync(path.join(directory, "manifest.json"), "utf8")).toBe(sourceManifestText);
    expect(
      JSON.parse(readFileSync(path.join(directory, "ledger.json"), "utf8")).manifestSha256,
    ).toBe("0".repeat(64));
  });

  it("reports missing historical commit objects through the batch check", () => {
    const ledger = structuredClone(sourceLedger) as unknown as Ledger;
    const missing = "0".repeat(40);
    const result = runWith({
      ...ledger,
      historicalEntries: [
        {
          upstreamSha: missing,
          subject: "Missing fixture",
          disposition: "deferred",
          reviewStatus: "legacy",
          reason: "Historical fixture with an absent object.",
        },
      ],
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`historical upstream SHA is not a commit: ${missing}`);
  });

  it("validation leaves an existing journal and canonical files untouched", () => {
    const { files } = filePair();
    writeFileSync(files.manifest, sourceManifestText);
    writeFileSync(files.ledger, JSON.stringify(sourceLedger));
    const journal = `${files.ledger}.refresh-journal`;
    writeFileSync(journal, "");
    const before = [files.manifest, files.ledger, journal].map((file) =>
      readFileSync(file, "utf8"),
    );
    const result = spawnSync(process.execPath, [SCRIPT], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        F5_UPSTREAM_PORTS_MANIFEST_PATH: files.manifest,
        F5_UPSTREAM_PORTS_LEDGER_PATH: files.ledger,
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("validation is read-only");
    expect(
      [files.manifest, files.ledger, journal].map((file) => readFileSync(file, "utf8")),
    ).toEqual(before);
  });

  it.each(["", '{"pid":'])("reports an actionable malformed journal error (%j)", (text) => {
    const { files, previous } = filePair();
    const journal = `${files.ledger}.refresh-journal`;
    writeFileSync(journal, text);
    expect(() => recoverPortFiles(files)).toThrow(
      `empty or truncated refresh journal. Inspect ${journal}`,
    );
    expect(readFileSync(files.manifest, "utf8")).toBe(previous.manifest);
    expect(readFileSync(journal, "utf8")).toBe(text);
  });

  function interruptedJournal(
    files: ReturnType<typeof filePair>["files"],
    previous: ReturnType<typeof filePair>["previous"],
  ) {
    writeFileSync(
      `${files.ledger}.refresh-journal`,
      JSON.stringify({
        ...previous,
        paths: files,
        host: hostname(),
        pid: process.pid,
        processStart: "a previous process with this PID",
      }),
    );
  }
  it("recovers a journal whose PID has been reused", () => {
    const { files, previous } = filePair();
    interruptedJournal(files, previous);
    writeFileSync(files.manifest, "interrupted generation");
    recoverPortFiles(files);
    expect(readPortFiles(files)).toEqual(previous);
  });
  it("names a leftover recovery lock and preserves the recovery data", () => {
    const { files, previous } = filePair();
    interruptedJournal(files, previous);
    const lock = `${files.ledger}.refresh-journal.recovering`;
    mkdirSync(lock);
    expect(() => recoverPortFiles(files)).toThrow(`refresh recovery lock exists: ${lock}`);
    expect(existsSync(`${files.ledger}.refresh-journal`)).toBe(true);
  });
  it("keeps a finished publication when only journal cleanup was interrupted", () => {
    const { files, previous } = filePair();
    const next = { manifest: "finished manifest", ledger: "finished ledger" };
    writeFileSync(files.manifest, next.manifest);
    writeFileSync(files.ledger, next.ledger);
    writeFileSync(
      `${files.ledger}.refresh-journal`,
      JSON.stringify({
        ...previous,
        paths: files,
        host: hostname(),
        pid: process.pid,
        processStart: "previous process",
        nextDigest: { manifest: sha256(next.manifest), ledger: sha256(next.ledger) },
      }),
    );
    recoverPortFiles(files);
    expect(readPortFiles(files)).toEqual(next);
  });
  it.skipIf(process.platform === "win32")("preserves each canonical file's permissions", () => {
    const { files, previous } = filePair();
    chmodSync(files.manifest, 0o644);
    chmodSync(files.ledger, 0o640);
    writePortFiles(files, previous, { manifest: "new", ledger: "new" });
    expect(statSync(files.manifest).mode & 0o777).toBe(0o644);
    expect(statSync(files.ledger).mode & 0o777).toBe(0o640);
  });
});
