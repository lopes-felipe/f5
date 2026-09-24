import { createHash } from "node:crypto";

export const SHA_PATTERN = /^[0-9a-f]{40}$/;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const DISPOSITIONS = [
  "ported",
  "already-present",
  "equivalent",
  "not-applicable",
  "declined",
  "deferred",
] as const;
export type Disposition = (typeof DISPOSITIONS)[number];
export type ReviewStatus = "pending" | "reviewed" | "legacy";
export interface FrozenCommit {
  readonly sha: string;
  readonly subject: string;
}
export interface LedgerEntry {
  readonly upstreamSha: string;
  readonly subject: string;
  readonly disposition: Disposition;
  readonly reason?: string;
  readonly f5Shas?: ReadonlyArray<string>;
  readonly evidence?: ReadonlyArray<string>;
  readonly reviewStatus?: ReviewStatus;
  readonly plannedWorkstream?: string;
}
/** Historical explanations only: these categories never provide active coverage. */
export interface OlderBacklogCategory {
  readonly category: string;
  readonly promotedUpstreamShas?: ReadonlyArray<string>;
  readonly selection: string;
  readonly disposition: Disposition;
  readonly reason: string;
  readonly upstreamShas?: ReadonlyArray<string>;
  readonly f5Shas?: ReadonlyArray<string>;
  readonly evidence?: ReadonlyArray<string>;
}
export interface Coverage {
  readonly count: number;
  readonly digest: string;
  readonly upstreamShas: ReadonlyArray<string>;
}
export interface Audit extends Coverage {
  readonly baseSha: string;
  readonly targetSha: string;
  readonly selection: "first-parent";
}
export interface Ledger {
  readonly schemaVersion: 6;
  readonly entries: ReadonlyArray<LedgerEntry>;
  readonly intervals: ReadonlyArray<Audit>;
  readonly legacyCoverage: Coverage;
  readonly legacyProvenance: ReadonlyArray<OlderBacklogCategory>;
}
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
export function makeCoverage(upstreamShas: ReadonlyArray<string>): Coverage {
  return {
    count: upstreamShas.length,
    digest: sha256(upstreamShas.join("\n") + "\n"),
    upstreamShas,
  };
}
export function makeAudit(
  baseSha: string,
  targetSha: string,
  upstreamShas: ReadonlyArray<string>,
): Audit {
  return { baseSha, targetSha, selection: "first-parent", ...makeCoverage(upstreamShas) };
}
export function sortEntries(entries: Iterable<LedgerEntry>): LedgerEntry[] {
  return [...entries].sort((a, b) =>
    a.upstreamSha < b.upstreamSha ? -1 : a.upstreamSha > b.upstreamSha ? 1 : 0,
  );
}
/** Frozen tracked history, newest first. Reviews and implementation progress are independent. */
export function trackedShas(ledger: Ledger): string[] {
  return [...ledger.intervals].reverse().flatMap((interval) => [...interval.upstreamShas]);
}
export function coveredInterval(ledger: Ledger, baseSha: string, targetSha: string): string[] {
  const shas = trackedShas(ledger);
  const target = shas.indexOf(targetSha);
  const base = baseSha === ledger.intervals[0]?.baseSha ? shas.length : shas.indexOf(baseSha);
  if (target < 0 || base <= target)
    throw new Error("classification boundaries must select a nonempty already-covered interval");
  return shas.slice(target, base);
}
export function validateAudit(ledger: Ledger): string[] {
  const errors: string[] = [];
  const covered = new Set<string>();
  const checkCoverage = (coverage: Coverage, label: string) => {
    if (coverage.count !== coverage.upstreamShas.length)
      errors.push(`${label} count differs from frozen selection`);
    if (coverage.digest !== makeCoverage(coverage.upstreamShas).digest)
      errors.push(`${label} digest differs from ordered SHA list`);
    for (const sha of coverage.upstreamShas) {
      if (!SHA_PATTERN.test(sha)) errors.push(`invalid coverage SHA ${sha}`);
      if (covered.has(sha)) errors.push(`duplicate coverage SHA ${sha}`);
      covered.add(sha);
    }
  };
  if (!ledger.intervals.length) errors.push("ledger requires at least one pinned interval");
  let precedingTarget: string | undefined;
  for (const interval of ledger.intervals) {
    if (!SHA_PATTERN.test(interval.baseSha) || !SHA_PATTERN.test(interval.targetSha))
      errors.push("invalid interval boundary SHA");
    if (interval.selection !== "first-parent")
      errors.push("interval selection must be first-parent");
    if (
      !interval.upstreamShas.length ||
      interval.upstreamShas[0] !== interval.targetSha ||
      interval.upstreamShas.includes(interval.baseSha)
    )
      errors.push("interval boundaries differ from frozen selection");
    if (precedingTarget !== undefined && interval.baseSha !== precedingTarget)
      errors.push("intervals are not contiguous");
    checkCoverage(interval, "interval");
    precedingTarget = interval.targetSha;
  }
  checkCoverage(ledger.legacyCoverage, "legacy coverage");
  if (
    JSON.stringify(ledger.legacyCoverage.upstreamShas) !==
    JSON.stringify([...ledger.legacyCoverage.upstreamShas].sort())
  )
    errors.push("legacy coverage must be sorted by SHA");
  const entries = new Set<string>();
  for (const entry of ledger.entries) {
    if (entries.has(entry.upstreamSha)) errors.push(`duplicate ledger SHA ${entry.upstreamSha}`);
    entries.add(entry.upstreamSha);
    if (!covered.has(entry.upstreamSha)) errors.push(`extra ledger SHA ${entry.upstreamSha}`);
  }
  for (const sha of covered) if (!entries.has(sha)) errors.push(`missing ledger SHA ${sha}`);
  if (
    JSON.stringify(ledger.entries.map((e) => e.upstreamSha)) !== JSON.stringify([...entries].sort())
  )
    errors.push("entries must be sorted by SHA");
  return errors;
}
/** Only append discovery; never rewrite existing review decisions. */
export function appendInterval(
  ledger: Ledger,
  commits: ReadonlyArray<FrozenCommit>,
  suggest: (commit: FrozenCommit) => LedgerEntry,
): Ledger {
  const errors = validateAudit(ledger);
  if (errors.length) throw new Error(errors.join("\n"));
  if (!commits.length) return ledger;
  const previous = new Map(ledger.entries.map((e) => [e.upstreamSha, e]));
  for (const commit of commits) {
    if (previous.has(commit.sha))
      throw new Error(`new interval overlaps tracked SHA ${commit.sha}`);
    previous.set(commit.sha, {
      ...suggest(commit),
      upstreamSha: commit.sha,
      subject: commit.subject,
      reviewStatus: "pending",
    });
  }
  const next: Ledger = {
    ...ledger,
    entries: sortEntries(previous.values()),
    intervals: [
      ...ledger.intervals,
      makeAudit(
        ledger.intervals.at(-1)!.targetSha,
        commits[0]!.sha,
        commits.map((c) => c.sha),
      ),
    ],
  };
  const nextErrors = validateAudit(next);
  if (nextErrors.length) throw new Error(nextErrors.join("\n"));
  return next;
}
