import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { canonicalJson, digestShas, type RunGitSync } from "@t3tools/shared/upstreamPorts";
import { afterEach, describe, expect, it } from "vitest";

import {
  migrateUpstreamLedger,
  OLD_LEDGER_PATH,
  SEED_POLICY,
  SEED_RULES,
  type MigrationStep,
} from "./migrate-upstream-ledger-v7.ts";

const sha = (seed: string) => seed.padStart(40, "0");
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function schema6(pending = false) {
  const intervalShas = [sha("b2"), sha("b1")];
  const legacyShas = [sha("c1")];
  return `${JSON.stringify(
    {
      schemaVersion: 6,
      entries: [
        {
          upstreamSha: sha("b1"),
          subject: "one",
          disposition: "not-applicable",
          reason: "x",
          reviewStatus: pending ? "pending" : "reviewed",
        },
        { upstreamSha: sha("b2"), subject: "two", disposition: "deferred", reason: "later" },
        { upstreamSha: sha("c1"), subject: "old", disposition: "deferred", reason: "old" },
      ],
      intervals: [
        {
          baseSha: sha("a0"),
          targetSha: sha("b2"),
          selection: "first-parent",
          count: 2,
          digest: digestShas(intervalShas),
          upstreamShas: intervalShas,
        },
      ],
      legacyCoverage: { count: 1, digest: digestShas(legacyShas), upstreamShas: legacyShas },
      legacyProvenance: [],
    },
    null,
    2,
  )}\n`;
}

const fakeGit: RunGitSync = (args) => {
  if (args[0] === "remote") return "git@github.com:pingdotgg/t3code.git";
  // Main has already dropped the schema-6 ledger unless a test says otherwise.
  if (args[0] === "rev-parse" && args.at(-1)!.endsWith(`:${OLD_LEDGER_PATH}`))
    throw new Error("missing");
  if (args[0] === "rev-parse") return sha("b2");
  if (args[0] === "rev-list") return [sha("b2"), sha("b1"), sha("a0")].join("\n");
  if (args[0] === "log")
    return [`${sha("b2")}\x1ftwo`, `${sha("b1")}\x1fone`, `${sha("c1")}\x1fold`].join("\n");
  throw new Error(`unexpected git ${args.join(" ")}`);
};

function fixtureRoot(options: { pending?: boolean; projectFile?: string } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "upstream-migration-"));
  directories.push(root);
  mkdirSync(path.join(root, "scripts"));
  writeFileSync(path.join(root, OLD_LEDGER_PATH), schema6(options.pending));
  if (options.projectFile !== undefined)
    writeFileSync(path.join(root, "f5.json"), options.projectFile);
  return root;
}

const read = (root: string, relative: string) => readFileSync(path.join(root, relative), "utf8");

describe("migrateUpstreamLedger", () => {
  it("produces the exact destination files, and a rerun is a no-op", () => {
    const root = fixtureRoot();
    expect(migrateUpstreamLedger({ root, runGit: fakeGit })).toEqual({
      outcome: "migrated",
      legacyRemaining: 2,
    });
    expect(existsSync(path.join(root, OLD_LEDGER_PATH))).toBe(false);
    expect(read(root, "upstream/archive/schema6.json")).toBe(schema6());
    expect(read(root, "upstream/rules.json")).toBe(canonicalJson(SEED_RULES));
    expect(read(root, "upstream/policy.md")).toBe(SEED_POLICY);
    expect(JSON.parse(read(root, "f5.json"))).toEqual({
      upstream: {
        repository: "https://github.com/pingdotgg/t3code.git",
        remote: "upstream",
        branch: "main",
      },
    });
    const before = ["upstream/archive/schema6.json", "upstream/rules.json", "f5.json"].map((file) =>
      read(root, file),
    );
    expect(migrateUpstreamLedger({ root, runGit: fakeGit }).outcome).toBe("already-migrated");
    expect(
      ["upstream/archive/schema6.json", "upstream/rules.json", "f5.json"].map((file) =>
        read(root, file),
      ),
    ).toEqual(before);
  });

  it("fails on pending records and reports their SHAs", () => {
    const root = fixtureRoot({ pending: true });
    expect(() => migrateUpstreamLedger({ root, runGit: fakeGit })).toThrow(sha("b1"));
    expect(existsSync(path.join(root, "upstream"))).toBe(false);
  });

  it.each<MigrationStep>(["archive", "seeds", "verified"])(
    "resumes to the verified final state after an interruption at %s",
    (step) => {
      const root = fixtureRoot();
      expect(() =>
        migrateUpstreamLedger({
          root,
          runGit: fakeGit,
          afterStep: (current) => {
            if (current === step) throw new Error("interrupted");
          },
        }),
      ).toThrow("interrupted");
      expect(migrateUpstreamLedger({ root, runGit: fakeGit }).outcome).toBe("migrated");
      expect(read(root, "upstream/archive/schema6.json")).toBe(schema6());
      expect(existsSync(path.join(root, OLD_LEDGER_PATH))).toBe(false);
    },
  );

  it("resumes when only the archive remains", () => {
    const root = fixtureRoot();
    migrateUpstreamLedger({ root, runGit: fakeGit });
    rmSync(path.join(root, "upstream/policy.md"));
    expect(migrateUpstreamLedger({ root, runGit: fakeGit }).outcome).toBe("already-migrated");
    expect(read(root, "upstream/policy.md")).toBe(SEED_POLICY);
  });

  it("refuses an archive that is stale relative to main's schema-6 ledger", () => {
    const root = fixtureRoot();
    migrateUpstreamLedger({ root, runGit: fakeGit });
    const withMain =
      (mainBlob: string): RunGitSync =>
      (args) => {
        if (args[0] === "rev-parse" && args.at(-1) === `origin/main:${OLD_LEDGER_PATH}`)
          return mainBlob;
        if (args[0] === "hash-object") return "archive-blob";
        return fakeGit(args);
      };
    expect(() => migrateUpstreamLedger({ root, runGit: withMain("newer-blob") })).toThrow(
      "stale archive",
    );
    expect(migrateUpstreamLedger({ root, runGit: withMain("archive-blob") }).outcome).toBe(
      "already-migrated",
    );
  });

  it("fails on conflicting archive bytes", () => {
    const root = fixtureRoot();
    mkdirSync(path.join(root, "upstream/archive"), { recursive: true });
    writeFileSync(path.join(root, "upstream/archive/schema6.json"), "{}\n");
    expect(() => migrateUpstreamLedger({ root, runGit: fakeGit })).toThrow("conflicting archive");
  });

  it("fails when neither the old ledger nor the archive exists", () => {
    const root = fixtureRoot();
    rmSync(path.join(root, OLD_LEDGER_PATH));
    expect(() => migrateUpstreamLedger({ root, runGit: fakeGit })).toThrow("neither");
  });

  it("preserves existing f5.json keys", () => {
    const root = fixtureRoot({
      projectFile: '{\n  // team defaults\n  "defaultThreadEnvMode": "worktree",\n}\n',
    });
    migrateUpstreamLedger({ root, runGit: fakeGit });
    expect(JSON.parse(read(root, "f5.json"))).toMatchObject({
      defaultThreadEnvMode: "worktree",
      upstream: { repository: "https://github.com/pingdotgg/t3code.git" },
    });
  });

  it("requires the verified upstream remote", () => {
    const root = fixtureRoot();
    const wrong: RunGitSync = (args) =>
      args[0] === "remote" ? "https://github.com/someone/else.git" : fakeGit(args);
    expect(() => migrateUpstreamLedger({ root, runGit: wrong })).toThrow("points at");
  });
});

// Runs against this checkout's real ledger when the upstream remote is fetched.
const repoRoot = path.resolve(import.meta.dirname, "..");
const realGit: RunGitSync = (args) =>
  execFileSync("git", [...args], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
function realLedgerText(): string | null {
  for (const file of [OLD_LEDGER_PATH, "upstream/archive/schema6.json"]) {
    const absolute = path.join(repoRoot, file);
    if (existsSync(absolute)) return readFileSync(absolute, "utf8");
  }
  return null;
}
function hasUpstream(): boolean {
  try {
    realGit(["rev-parse", "--verify", "--quiet", "refs/remotes/upstream/main"]);
    return true;
  } catch {
    return false;
  }
}

describe.runIf(hasUpstream() && realLedgerText() !== null)("real ledger migration", () => {
  it("keeps the archive byte-identical and validates with provenance", { timeout: 60_000 }, () => {
    const text = realLedgerText()!;
    const root = mkdtempSync(path.join(tmpdir(), "upstream-migration-real-"));
    directories.push(root);
    mkdirSync(path.join(root, "scripts"));
    writeFileSync(path.join(root, OLD_LEDGER_PATH), text);
    const result = migrateUpstreamLedger({ root, runGit: realGit });
    expect(read(root, "upstream/archive/schema6.json")).toBe(text);
    const deferred = (
      JSON.parse(text) as { entries: Array<{ disposition: string }> }
    ).entries.filter((entry) => entry.disposition === "deferred").length;
    expect(result.legacyRemaining).toBe(deferred);
  });
});
