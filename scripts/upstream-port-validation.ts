import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  DISPOSITIONS,
  SHA_PATTERN,
  REVIEW_PLACEHOLDER_PATTERN,
  validateAudit,
  type Ledger,
  type LedgerEntry,
} from "./upstream-port-ledger.ts";
import { UPSTREAM_MAIN_REF, verifyUpstream, type RunGit } from "./upstream-port-history.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const strings = (value: unknown): boolean =>
  Array.isArray(value) && value.every((v) => typeof v === "string");
const optionalStrings = (value: unknown): boolean => value === undefined || strings(value);
const record = (value: unknown): boolean =>
  isRecord(value) && optionalStrings(value.f5Shas) && optionalStrings(value.evidence);
const coverage = (value: unknown): boolean => isRecord(value) && strings(value.upstreamShas);
export function parseLedger(text: string): Ledger {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || value.schemaVersion !== 6)
    throw new Error("schema 6 required; run --migrate for a schema-5 ledger");
  if (
    !Array.isArray(value.entries) ||
    !value.entries.every(record) ||
    !Array.isArray(value.intervals) ||
    !value.intervals.every(coverage) ||
    !coverage(value.legacyCoverage) ||
    !Array.isArray(value.legacyProvenance) ||
    !value.legacyProvenance.every(
      (v) =>
        record(v) &&
        isRecord(v) &&
        optionalStrings(v.upstreamShas) &&
        optionalStrings(v.promotedUpstreamShas),
    )
  )
    throw new Error("malformed schema-6 ledger records or coverage");
  for (const removed of [
    "manifest",
    "manifestSha256",
    "historicalEntries",
    "audit",
    "olderBacklog",
  ])
    if (removed in value) throw new Error(`obsolete schema-5 field ${removed}`);
  return value as unknown as Ledger;
}
const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
export function validateEvidence(
  root: string,
  owner: string,
  evidence: ReadonlyArray<string> | undefined,
  errors: string[],
): void {
  for (const value of evidence ?? []) {
    const match = /^(.+):([1-9][0-9]*)$/.exec(value);
    if (!match) {
      errors.push(`${owner} has malformed file:line evidence ${JSON.stringify(value)}`);
      continue;
    }
    const repositoryPath = match[1]!;
    const line = Number(match[2]);
    if (path.isAbsolute(repositoryPath) || repositoryPath.split(/[\\/]/).includes("..")) {
      errors.push(`${owner} evidence must be a repository-relative path: ${value}`);
      continue;
    }
    const absolutePath = path.resolve(root, repositoryPath);
    if (!absolutePath.startsWith(`${root}${path.sep}`)) {
      errors.push(`${owner} evidence escapes the repository: ${value}`);
      continue;
    }
    try {
      if (!statSync(absolutePath).isFile()) {
        errors.push(`${owner} evidence is not a file: ${value}`);
        continue;
      }
      const text = readFileSync(absolutePath, "utf8");
      const lineCount =
        text.length === 0 ? 0 : text.split(/\r?\n/).length - (/\r?\n$/.test(text) ? 1 : 0);
      if (line > lineCount) {
        errors.push(`${owner} evidence line is out of range (${lineCount} lines): ${value}`);
      }
    } catch {
      errors.push(`${owner} evidence file does not exist: ${value}`);
    }
  }
}

export function validateEntries(
  entries: ReadonlyArray<LedgerEntry>,
  root: string,
  allowPending = false,
): string[] {
  const errors: string[] = [];
  for (const entry of entries) {
    const owner = `ledger SHA ${entry.upstreamSha}`;
    if (!SHA_PATTERN.test(entry.upstreamSha)) errors.push(`${owner} is invalid`);
    if (!nonempty(entry.subject)) errors.push(`${owner} has no subject`);
    if (!["pending", "reviewed", "legacy"].includes(entry.reviewStatus ?? ""))
      errors.push(`${owner} has invalid reviewStatus`);
    if (
      (!allowPending || entry.reviewStatus !== "pending") &&
      (entry.reviewStatus === "pending" || REVIEW_PLACEHOLDER_PATTERN.test(entry.reason ?? ""))
    )
      errors.push(`${owner} requires review`);
    if (entry.plannedWorkstream !== undefined && !nonempty(entry.plannedWorkstream))
      errors.push(`${owner} has empty plannedWorkstream`);
    if (!DISPOSITIONS.includes(entry.disposition))
      errors.push(`${owner} has invalid disposition ${entry.disposition}`);
    const completed = ["ported", "already-present", "equivalent"].includes(entry.disposition);
    if (completed && !entry.f5Shas?.length) errors.push(`${owner} has no f5 SHA`);
    if (!completed && !nonempty(entry.reason)) errors.push(`${owner} has no concrete reason`);
    if (["equivalent", "already-present"].includes(entry.disposition) && !entry.evidence?.length)
      errors.push(`${owner} has no file:line evidence`);
    validateEvidence(root, owner, entry.evidence, errors);
    for (const sha of entry.f5Shas ?? [])
      if (!SHA_PATTERN.test(sha)) errors.push(`${owner} has invalid f5 SHA ${sha}`);
  }
  return errors;
}
export function validateLedger(ledger: Ledger, root: string, allowPending = false): string[] {
  const errors = [...validateAudit(ledger), ...validateEntries(ledger.entries, root, allowPending)];
  const entries = new Set(ledger.entries.map((e) => e.upstreamSha));
  for (const category of ledger.legacyProvenance) {
    if (
      !nonempty(category.category) ||
      !nonempty(category.selection) ||
      !nonempty(category.reason) ||
      !DISPOSITIONS.includes(category.disposition)
    )
      errors.push("invalid legacy provenance category");
    for (const sha of [...(category.upstreamShas ?? []), ...(category.promotedUpstreamShas ?? [])])
      if (!SHA_PATTERN.test(sha) || !entries.has(sha))
        errors.push(`legacy provenance references missing record ${sha}`);
    for (const sha of category.f5Shas ?? [])
      if (!SHA_PATTERN.test(sha)) errors.push(`invalid legacy provenance f5 SHA ${sha}`);
    validateEvidence(root, `legacy provenance ${category.category}`, category.evidence, errors);
  }
  return errors;
}
/** One ancestry read and one reachable-history read; no git subprocess per SHA. */
export function validateProvenance(ledger: Ledger, git: RunGit): void {
  verifyUpstream(git);
  const ancestry = git(["rev-list", "--first-parent", UPSTREAM_MAIN_REF]).split("\n");
  for (const interval of ledger.intervals) {
    const head = ancestry.indexOf(interval.targetSha);
    const base = ancestry.indexOf(interval.baseSha);
    if (
      head < 0 ||
      base <= head ||
      JSON.stringify(ancestry.slice(head, base)) !== JSON.stringify(interval.upstreamShas)
    )
      throw new Error("interval differs from upstream first-parent ancestry");
  }
  const head = ledger.intervals.at(-1)!.targetSha;
  const subjects = new Map(
    git(["log", "--format=%H%x09%s", head])
      .split("\n")
      .filter(Boolean)
      .map((line) => [line.slice(0, 40), line.slice(41)]),
  );
  for (const entry of ledger.entries) {
    if (!subjects.has(entry.upstreamSha))
      throw new Error(`upstream SHA is not reachable from pinned history: ${entry.upstreamSha}`);
    if (subjects.get(entry.upstreamSha) !== entry.subject)
      throw new Error(`upstream subject differs for ${entry.upstreamSha}`);
  }
}
export function assertValid(ledger: Ledger, root: string, allowPending = false): void {
  const errors = validateLedger(ledger, root, allowPending);
  if (errors.length) throw new Error(errors.join("\n"));
}
