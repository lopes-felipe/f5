/**
 * Read-only access to the immutable schema-6 archive (`upstream/archive/schema6.json`).
 *
 * Structure, digests, and provenance are verified. Schema-6 evidence rules
 * (file:line resolution) are not re-checked: the archive is frozen history.
 */
import { digestShas, SHA_PATTERN, type ArchiveContext, type RunGitSync } from "./upstreamPorts";

export const ARCHIVE_DISPOSITIONS = [
  "ported",
  "already-present",
  "equivalent",
  "not-applicable",
  "declined",
  "deferred",
] as const;
export type ArchiveDisposition = (typeof ARCHIVE_DISPOSITIONS)[number];

export interface ArchiveEntry {
  readonly upstreamSha: string;
  readonly subject: string;
  readonly disposition: ArchiveDisposition;
  readonly reason?: string;
  readonly f5Shas?: ReadonlyArray<string>;
  readonly evidence?: ReadonlyArray<string>;
  readonly reviewStatus?: "pending" | "reviewed" | "legacy";
  readonly plannedWorkstream?: string;
}

export interface ArchiveCoverage {
  readonly count: number;
  readonly digest: string;
  readonly upstreamShas: ReadonlyArray<string>;
}

export interface ArchiveInterval extends ArchiveCoverage {
  readonly baseSha: string;
  readonly targetSha: string;
  readonly selection: "first-parent";
}

export interface ArchiveProvenanceCategory {
  readonly category: string;
  readonly selection: string;
  readonly disposition: ArchiveDisposition;
  readonly reason: string;
  readonly upstreamShas?: ReadonlyArray<string>;
  readonly promotedUpstreamShas?: ReadonlyArray<string>;
  readonly f5Shas?: ReadonlyArray<string>;
  readonly evidence?: ReadonlyArray<string>;
}

export interface Schema6Archive {
  readonly schemaVersion: 6;
  readonly entries: ReadonlyArray<ArchiveEntry>;
  readonly intervals: ReadonlyArray<ArchiveInterval>;
  readonly legacyCoverage: ArchiveCoverage;
  readonly legacyProvenance: ReadonlyArray<ArchiveProvenanceCategory>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");
const optionalStrings = (value: unknown) => value === undefined || strings(value);
const coverageShape = (value: unknown) =>
  isRecord(value) &&
  typeof value.count === "number" &&
  typeof value.digest === "string" &&
  strings(value.upstreamShas);

export function parseArchive(text: string): Schema6Archive {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || value.schemaVersion !== 6)
    throw new Error("archive must be a schema-6 ledger");
  if (
    !Array.isArray(value.entries) ||
    !value.entries.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.upstreamSha === "string" &&
        typeof entry.subject === "string" &&
        typeof entry.disposition === "string" &&
        optionalStrings(entry.f5Shas) &&
        optionalStrings(entry.evidence),
    ) ||
    !Array.isArray(value.intervals) ||
    !value.intervals.every(
      (interval) =>
        coverageShape(interval) &&
        isRecord(interval) &&
        typeof interval.baseSha === "string" &&
        typeof interval.targetSha === "string",
    ) ||
    !coverageShape(value.legacyCoverage) ||
    !Array.isArray(value.legacyProvenance) ||
    !value.legacyProvenance.every(
      (category) =>
        isRecord(category) &&
        optionalStrings(category.upstreamShas) &&
        optionalStrings(category.promotedUpstreamShas) &&
        optionalStrings(category.f5Shas),
    )
  )
    throw new Error("malformed schema-6 archive records or coverage");
  return value as unknown as Schema6Archive;
}

/** Structure and coverage checks; returns errors. Pending records are reported separately. */
export function validateArchive(archive: Schema6Archive): string[] {
  const errors: string[] = [];
  const covered = new Set<string>();
  const checkCoverage = (coverage: ArchiveCoverage, label: string, sorted: boolean) => {
    if (coverage.count !== coverage.upstreamShas.length)
      errors.push(`archive ${label} count differs from its SHA list`);
    const ordered = sorted ? coverage.upstreamShas.toSorted() : coverage.upstreamShas;
    if (sorted && JSON.stringify(ordered) !== JSON.stringify(coverage.upstreamShas))
      errors.push(`archive ${label} must be sorted by SHA`);
    if (coverage.digest !== digestShas(coverage.upstreamShas))
      errors.push(`archive ${label} digest differs from its SHA list`);
    for (const sha of coverage.upstreamShas) {
      if (!SHA_PATTERN.test(sha)) errors.push(`archive ${label} has invalid SHA ${sha}`);
      if (covered.has(sha)) errors.push(`archive duplicate coverage SHA ${sha}`);
      covered.add(sha);
    }
  };
  if (archive.intervals.length === 0) errors.push("archive requires at least one interval");
  let previousTarget: string | undefined;
  archive.intervals.forEach((interval, index) => {
    const label = `interval ${index + 1}`;
    if (!SHA_PATTERN.test(interval.baseSha) || !SHA_PATTERN.test(interval.targetSha))
      errors.push(`archive ${label} has an invalid boundary SHA`);
    if (interval.selection !== "first-parent")
      errors.push(`archive ${label} selection must be first-parent`);
    if (
      interval.upstreamShas[0] !== interval.targetSha ||
      interval.upstreamShas.includes(interval.baseSha)
    )
      errors.push(`archive ${label} boundaries differ from its SHA list`);
    if (previousTarget !== undefined && interval.baseSha !== previousTarget)
      errors.push(`archive intervals are not contiguous at ${label}`);
    checkCoverage(interval, label, false);
    previousTarget = interval.targetSha;
  });
  checkCoverage(archive.legacyCoverage, "legacy coverage", true);
  const entries = new Set<string>();
  let previous = "";
  for (const entry of archive.entries) {
    const owner = `archive record ${entry.upstreamSha}`;
    if (!SHA_PATTERN.test(entry.upstreamSha)) errors.push(`${owner} has an invalid SHA`);
    if (entries.has(entry.upstreamSha)) errors.push(`${owner} is duplicated`);
    if (entry.upstreamSha < previous) errors.push("archive records must be sorted by SHA");
    previous = entry.upstreamSha;
    entries.add(entry.upstreamSha);
    if (!covered.has(entry.upstreamSha)) errors.push(`${owner} is not covered`);
    if (!(ARCHIVE_DISPOSITIONS as ReadonlyArray<string>).includes(entry.disposition))
      errors.push(`${owner} has invalid disposition ${entry.disposition}`);
    for (const sha of entry.f5Shas ?? [])
      if (!SHA_PATTERN.test(sha)) errors.push(`${owner} has invalid f5 SHA ${sha}`);
  }
  for (const sha of covered) if (!entries.has(sha)) errors.push(`archive is missing record ${sha}`);
  for (const category of archive.legacyProvenance)
    for (const sha of [...(category.upstreamShas ?? []), ...(category.promotedUpstreamShas ?? [])])
      if (!entries.has(sha)) errors.push(`archive provenance references missing record ${sha}`);
  return errors;
}

export function pendingArchiveShas(archive: Schema6Archive): string[] {
  return archive.entries
    .filter((entry) => entry.reviewStatus === "pending")
    .map((entry) => entry.upstreamSha);
}

/**
 * Each archive interval equals its first-parent slice of `remoteRef`, and every
 * record is reachable from the last pinned target with a matching subject.
 */
export function validateArchiveProvenance(
  archive: Schema6Archive,
  runGit: RunGitSync,
  remoteRef: string,
): string[] {
  const errors: string[] = [];
  const ancestry = runGit(["rev-list", "--first-parent", remoteRef]).split("\n").filter(Boolean);
  const position = new Map(ancestry.map((sha, index) => [sha, index]));
  archive.intervals.forEach((interval, index) => {
    const head = position.get(interval.targetSha);
    const base = position.get(interval.baseSha);
    if (
      head === undefined ||
      base === undefined ||
      base <= head ||
      JSON.stringify(ancestry.slice(head, base)) !== JSON.stringify(interval.upstreamShas)
    )
      errors.push(`archive interval ${index + 1} differs from ${remoteRef} first-parent history`);
  });
  const head = archive.intervals.at(-1)?.targetSha;
  if (!head) return errors;
  const subjects = new Map(
    runGit(["log", "--format=%H%x1f%s", head])
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, subject] = line.split("\x1f");
        return [sha!, subject ?? ""] as const;
      }),
  );
  for (const entry of archive.entries) {
    const subject = subjects.get(entry.upstreamSha);
    if (subject === undefined)
      errors.push(`archive record ${entry.upstreamSha} is not reachable from the pinned history`);
    else if (subject !== entry.subject)
      errors.push(`archive subject differs for ${entry.upstreamSha}`);
  }
  return errors;
}

export function archiveContext(archive: Schema6Archive): ArchiveContext {
  return {
    lastTargetSha: archive.intervals.at(-1)!.targetSha,
    deferredSubjects: new Map(
      archive.entries
        .filter((entry) => entry.disposition === "deferred")
        .map((entry) => [entry.upstreamSha, entry.subject]),
    ),
  };
}

export function archiveEntriesBySha(archive: Schema6Archive): Map<string, ArchiveEntry> {
  return new Map(archive.entries.map((entry) => [entry.upstreamSha, entry]));
}

/** Archive deferred SHAs not yet in any legacy batch, sorted ascending. */
export function remainingLegacyShas(
  archive: Schema6Archive,
  batchedShas: ReadonlySet<string>,
): string[] {
  return archive.entries
    .filter((entry) => entry.disposition === "deferred" && !batchedShas.has(entry.upstreamSha))
    .map((entry) => entry.upstreamSha)
    .toSorted();
}
