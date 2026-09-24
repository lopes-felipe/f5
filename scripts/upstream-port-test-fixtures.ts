import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AUTHORITATIVE_REPOSITORY, UPSTREAM_MAIN_REF } from "./upstream-port-history.ts";
import { makeAudit, makeCoverage, type Ledger, type LedgerEntry } from "./upstream-port-ledger.ts";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const SCRIPT = path.join(ROOT, "scripts/check-upstream-ports.ts");
export const sha = (n: number) => n.toString(16).padStart(40, "0");
export const entry = (n: number): LedgerEntry => ({
  upstreamSha: sha(n),
  subject: `Commit ${n}`,
  disposition: "deferred",
  reason: "Not selected for this implementation phase.",
  reviewStatus: "reviewed",
});
export function fixtureLedger(): Ledger {
  return {
    schemaVersion: 6,
    entries: [entry(1), entry(2)],
    intervals: [makeAudit(sha(0), sha(2), [sha(2), sha(1)])],
    legacyCoverage: makeCoverage([]),
    legacyProvenance: [],
  };
}
export function temp(): string {
  return mkdtempSync(path.join(tmpdir(), "f5-ledger-test-"));
}
/** Local Git history, including an authoritative-named remote; never accesses the network. */
export function repository(count = 4) {
  const directory = temp();
  const git = (args: ReadonlyArray<string>, input?: string) =>
    execFileSync("git", [...args], {
      cwd: directory,
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  git(["init"]);
  let stream = "";
  for (let n = 0; n < count; n++) {
    const subject = `Commit ${n}`;
    stream += `commit refs/heads/main\ncommitter Fixture <fixture@example.test> ${1600000000 + n} +0000\ndata ${subject.length}\n${subject}\n\n`;
  }
  git(["fast-import", "--quiet"], stream);
  const commits = git(["log", "--first-parent", "--format=%H%x09%s", "refs/heads/main"])
    .split("\n")
    .map((line) => ({ sha: line.slice(0, 40), subject: line.slice(41) }));
  git(["remote", "add", "upstream", AUTHORITATIVE_REPOSITORY]);
  git(["update-ref", UPSTREAM_MAIN_REF, commits[0]!.sha]);
  const ledger: Ledger = {
    schemaVersion: 6,
    entries: commits
      .slice(0, -1)
      .map((c) => ({ ...entry(1), upstreamSha: c.sha, subject: c.subject }))
      .sort((a, b) => a.upstreamSha.localeCompare(b.upstreamSha)),
    intervals: [
      makeAudit(
        commits.at(-1)!.sha,
        commits[0]!.sha,
        commits.slice(0, -1).map((c) => c.sha),
      ),
    ],
    legacyCoverage: makeCoverage([]),
    legacyProvenance: [],
  };
  const file = path.join(directory, "ledger.json");
  writeFileSync(file, JSON.stringify(ledger));
  return { directory, git, commits, ledger, file };
}
export function runCheck(
  directory: string,
  file: string,
  args: string[] = [],
  extraEnv: Record<string, string> = {},
) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      F5_UPSTREAM_PORTS_ROOT: directory,
      F5_UPSTREAM_PORTS_LEDGER_PATH: file,
      F5_REQUIRE_UPSTREAM: "1",
      ...extraEnv,
    },
  });
}
