import { readPortFiles, type PortFiles } from "./upstream-port-legacy-files.ts";
import {
  AUTHORITATIVE_REPOSITORY,
  UPSTREAM_MAIN_REF,
  verifyUpstream,
  type RunGit,
} from "./upstream-port-history.ts";
import {
  DISPOSITIONS,
  SHA_PATTERN,
  SHA256_PATTERN,
  sha256,
  makeCoverage,
  sortEntries,
  type Ledger,
  type FrozenCommit,
  type LedgerEntry,
} from "./upstream-port-ledger.ts";
import { validateLegacyAudit, type LegacyLedger } from "./upstream-port-legacy-ledger.ts";
import {
  assertValid,
  validateEvidence as checkEvidence,
  validateProvenance,
} from "./upstream-port-validation.ts";
import path from "node:path";
interface Manifest {
  readonly schemaVersion: 1;
  readonly upstream: {
    readonly authoritativeRepository: string;
    readonly localMirror: string;
    readonly localMirrorAuthoritative: false;
  };
  readonly selection: {
    readonly rule: "first-parent";
    readonly maxCount: 500;
    readonly headSha: string;
    readonly boundarySha: string;
    readonly firstSha: string;
    readonly lastSha: string;
    readonly count: number;
  };
  readonly commits: ReadonlyArray<FrozenCommit>;
}

export function migrateLegacyLedger(
  legacy: LegacyLedger,
  subjects: ReadonlyMap<string, string>,
): Ledger {
  const errors = validateLegacyAudit(legacy);
  if (errors.length) throw new Error(errors.join("\n"));
  const entries: LedgerEntry[] = [...legacy.entries, ...(legacy.historicalEntries ?? [])];
  const seen = new Set(entries.map((e) => e.upstreamSha));
  for (const category of legacy.olderBacklog) {
    for (const sha of category.upstreamShas ?? []) {
      if (seen.has(sha)) throw new Error(`duplicate legacy SHA ${sha}`);
      const subject = subjects.get(sha);
      if (!subject) throw new Error(`missing upstream subject for ${sha}`);
      seen.add(sha);
      entries.push({
        upstreamSha: sha,
        subject,
        disposition: category.disposition,
        reason: category.reason,
        reviewStatus: "legacy",
        ...(category.f5Shas ? { f5Shas: category.f5Shas } : {}),
        ...(category.evidence ? { evidence: category.evidence } : {}),
      });
    }
  }
  const audited = new Set(legacy.audit!.upstreamShas);
  return {
    schemaVersion: 6,
    entries: sortEntries(entries),
    intervals: [legacy.audit!],
    legacyCoverage: makeCoverage([...seen].filter((sha) => !audited.has(sha)).sort()),
    legacyProvenance: legacy.olderBacklog,
  };
}
/** Validate the old pair completely before schema 6 is published. Only --migrate calls this. */
export function prepareMigration(
  files: PortFiles,
  root: string,
  git: RunGit,
): { expected: string; expectedManifest: string; ledger: Ledger } {
  const ROOT = root;
  const MANIFEST_PATH = files.manifest;
  const LEDGER_PATH = files.ledger;
  const WINDOW_SIZE = 500; // Legacy format constraint; schema 6 has no window.
  const assertNonEmpty = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const validateEvidence = (
    owner: string,
    evidence: ReadonlyArray<string> | undefined,
    errors: string[],
  ) => checkEvidence(root, owner, evidence, errors);
  function readJson(filePath: string, text: string): unknown {
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`could not parse ${path.relative(ROOT, filePath)}: ${String(error)}`);
    }
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function readManifest(filePath: string, text: string): Manifest {
    const value = readJson(filePath, text);
    if (
      !isRecord(value) ||
      !isRecord(value.upstream) ||
      !isRecord(value.selection) ||
      !Array.isArray(value.commits) ||
      value.commits.some((commit) => !isRecord(commit))
    ) {
      throw new Error("manifest must contain upstream, selection, and a commits array");
    }
    return value as unknown as Manifest;
  }

  function readLedger(filePath: string, text: string): LegacyLedger {
    const value = readJson(filePath, text);
    const validStringArray = (candidate: unknown): boolean =>
      candidate === undefined ||
      (Array.isArray(candidate) && candidate.every((entry) => typeof entry === "string"));
    if (
      !isRecord(value) ||
      !Array.isArray(value.entries) ||
      value.entries.some(
        (entry) =>
          !isRecord(entry) || !validStringArray(entry.f5Shas) || !validStringArray(entry.evidence),
      ) ||
      (value.historicalEntries !== undefined &&
        (!Array.isArray(value.historicalEntries) ||
          value.historicalEntries.some(
            (entry) =>
              !isRecord(entry) ||
              !validStringArray(entry.f5Shas) ||
              !validStringArray(entry.evidence),
          ))) ||
      (value.audit !== undefined &&
        (!isRecord(value.audit) ||
          !Array.isArray(value.audit.upstreamShas) ||
          !validStringArray(value.audit.upstreamShas))) ||
      !Array.isArray(value.olderBacklog) ||
      value.olderBacklog.some(
        (category) =>
          !isRecord(category) ||
          !validStringArray(category.upstreamShas) ||
          !validStringArray(category.promotedUpstreamShas) ||
          !validStringArray(category.f5Shas) ||
          !validStringArray(category.evidence),
      )
    ) {
      throw new Error("ledger must contain entries and olderBacklog arrays");
    }
    return value as unknown as LegacyLedger;
  }

  const errors: string[] = [];
  const texts = readPortFiles({ manifest: MANIFEST_PATH, ledger: LEDGER_PATH });
  const manifestText = texts.manifest;
  const ledgerText = texts.ledger;
  const manifest = readManifest(MANIFEST_PATH, manifestText);
  const ledger = readLedger(LEDGER_PATH, ledgerText);

  if (manifest.schemaVersion !== 1) errors.push("unsupported manifest schemaVersion");
  if (ledger.schemaVersion !== 5) errors.push("unsupported ledger schemaVersion");
  if (ledger.manifest !== "scripts/upstream-ports.manifest.json")
    errors.push("ledger references an unsupported manifest path");
  if (!SHA256_PATTERN.test(ledger.manifestSha256)) {
    errors.push("ledger manifestSha256 is missing or invalid");
  } else if (ledger.manifestSha256 !== sha256(manifestText)) {
    errors.push("checked-in manifest does not match the ledger integrity digest");
  }
  if (manifest.upstream.authoritativeRepository !== AUTHORITATIVE_REPOSITORY) {
    errors.push("manifest authoritative repository does not match pingdotgg/t3code");
  }
  if (manifest.upstream.localMirrorAuthoritative !== false) {
    errors.push("the local convenience mirror must never be marked authoritative");
  }
  if (
    manifest.selection.rule !== "first-parent" ||
    manifest.selection.maxCount !== WINDOW_SIZE ||
    manifest.selection.count !== WINDOW_SIZE
  ) {
    errors.push("manifest selection must be exactly 500 first-parent commits");
  }
  if (manifest.commits.length !== WINDOW_SIZE) {
    errors.push(`manifest contains ${manifest.commits.length} commits instead of ${WINDOW_SIZE}`);
  }
  if (manifest.commits[0]?.sha !== manifest.selection.firstSha) {
    errors.push("manifest firstSha does not match its first commit");
  }
  if (manifest.selection.headSha !== manifest.selection.firstSha) {
    errors.push("manifest headSha must equal firstSha");
  }
  if (
    manifest.commits.at(-1)?.sha !== manifest.selection.lastSha ||
    manifest.selection.boundarySha !== manifest.selection.lastSha
  ) {
    errors.push("manifest boundary/last SHA does not match its final commit");
  }

  const manifestShas = new Set<string>();
  for (const [index, commit] of manifest.commits.entries()) {
    if (!SHA_PATTERN.test(commit.sha)) errors.push(`manifest commit ${index} has an invalid SHA`);
    if (!assertNonEmpty(commit.subject))
      errors.push(`manifest commit ${commit.sha} has no subject`);
    if (manifestShas.has(commit.sha)) errors.push(`duplicate manifest SHA ${commit.sha}`);
    manifestShas.add(commit.sha);
  }

  const ledgerShas = new Set<string>();
  const historical = ledger.historicalEntries ?? [];
  if (ledger.schemaVersion === 5) {
    if (!Array.isArray(ledger.historicalEntries))
      errors.push("schema 5 requires historicalEntries");
    errors.push(...validateLegacyAudit(ledger));
  }
  for (const entry of [...ledger.entries, ...historical]) {
    if (ledger.entries.includes(entry) && !manifestShas.has(entry.upstreamSha)) {
      errors.push(`ledger SHA ${entry.upstreamSha} is not in the frozen manifest`);
    }
    if (ledgerShas.has(entry.upstreamSha)) errors.push(`duplicate ledger SHA ${entry.upstreamSha}`);
    ledgerShas.add(entry.upstreamSha);
    if (!SHA_PATTERN.test(entry.upstreamSha))
      errors.push(`invalid ledger SHA ${entry.upstreamSha}`);
    if (!assertNonEmpty(entry.subject))
      errors.push(`ledger SHA ${entry.upstreamSha} has no subject`);
    if (historical.includes(entry) && manifestShas.has(entry.upstreamSha))
      errors.push(`historical SHA ${entry.upstreamSha} overlaps frozen manifest`);
    if (ledger.schemaVersion === 5) {
      if (!["pending", "reviewed", "legacy"].includes(entry.reviewStatus ?? ""))
        errors.push(`ledger SHA ${entry.upstreamSha} has invalid reviewStatus`);
      if (
        entry.reviewStatus === "pending" ||
        /requires manual.*assessment|manual assessment placeholder/i.test(entry.reason ?? "")
      )
        errors.push(
          `ledger SHA ${entry.upstreamSha} requires review; generic manual assessment is not an audited disposition`,
        );
      if (entry.plannedWorkstream !== undefined && !assertNonEmpty(entry.plannedWorkstream))
        errors.push(`ledger SHA ${entry.upstreamSha} has empty plannedWorkstream`);
    }
    if (!DISPOSITIONS.includes(entry.disposition)) {
      errors.push(`ledger SHA ${entry.upstreamSha} has invalid disposition ${entry.disposition}`);
      continue;
    }
    const completed =
      entry.disposition === "ported" ||
      entry.disposition === "already-present" ||
      entry.disposition === "equivalent";
    if (completed && (!entry.f5Shas || entry.f5Shas.length === 0)) {
      errors.push(`completed ledger SHA ${entry.upstreamSha} has no f5 SHA`);
    }
    if (!completed && !assertNonEmpty(entry.reason)) {
      errors.push(`skipped/deferred ledger SHA ${entry.upstreamSha} has no concrete reason`);
    }
    if (
      (entry.disposition === "already-present" || entry.disposition === "equivalent") &&
      (!entry.evidence || entry.evidence.length === 0)
    ) {
      errors.push(`already-present ledger SHA ${entry.upstreamSha} has no file:line evidence`);
    }
    validateEvidence(`ledger SHA ${entry.upstreamSha}`, entry.evidence, errors);
    for (const f5Sha of entry.f5Shas ?? []) {
      if (!SHA_PATTERN.test(f5Sha)) {
        errors.push(`ledger SHA ${entry.upstreamSha} has invalid f5 SHA ${f5Sha}`);
      }
    }
  }
  for (const sha of manifestShas) {
    if (!ledgerShas.has(sha)) errors.push(`manifest SHA ${sha} is missing from the ledger`);
  }

  const olderShas = new Set<string>();
  for (const category of ledger.olderBacklog) {
    if (!assertNonEmpty(category.category) || !assertNonEmpty(category.selection)) {
      errors.push("older-backlog categories require a name and selection rule");
    }
    if (!assertNonEmpty(category.reason)) {
      errors.push(`older-backlog category ${category.category} has no reason`);
    }
    if (!DISPOSITIONS.includes(category.disposition)) {
      errors.push(`older-backlog category ${category.category} has an invalid disposition`);
      continue;
    }
    const completed =
      category.disposition === "ported" || category.disposition === "already-present";
    if (completed && !category.upstreamShas?.length && !category.promotedUpstreamShas?.length) {
      errors.push(`completed older-backlog category ${category.category} has no upstream SHA`);
    }
    if (completed && (!category.f5Shas || category.f5Shas.length === 0)) {
      errors.push(`completed older-backlog category ${category.category} has no f5 SHA`);
    }
    if (
      category.disposition === "already-present" &&
      (!category.evidence || category.evidence.length === 0)
    ) {
      errors.push(`already-present older-backlog category ${category.category} has no evidence`);
    }
    if (
      category.disposition !== "already-present" &&
      category.evidence &&
      category.evidence.length > 0
    ) {
      errors.push(
        `older-backlog category ${category.category} has evidence outside already-present disposition`,
      );
    }
    validateEvidence(`older-backlog category ${category.category}`, category.evidence, errors);
    for (const sha of category.upstreamShas ?? []) {
      if (!SHA_PATTERN.test(sha)) errors.push(`older-backlog category has invalid SHA ${sha}`);
      if (ledgerShas.has(sha)) errors.push(`older-backlog SHA ${sha} overlaps the frozen manifest`);
      if (olderShas.has(sha)) errors.push(`duplicate older-backlog SHA ${sha}`);
      olderShas.add(sha);
    }
    for (const sha of category.promotedUpstreamShas ?? []) {
      if (!SHA_PATTERN.test(sha) || !ledgerShas.has(sha))
        errors.push(`promoted backlog SHA ${sha} has no per-SHA record`);
    }
    for (const f5Sha of category.f5Shas ?? []) {
      if (!SHA_PATTERN.test(f5Sha)) {
        errors.push(`older-backlog category ${category.category} has invalid f5 SHA ${f5Sha}`);
      }
    }
  }

  if (errors.length) throw new Error(errors.join("\n"));
  verifyUpstream(git);
  const ancestry = git(["rev-list", "--first-parent", UPSTREAM_MAIN_REF]).split("\n");
  if (!ancestry.includes(manifest.selection.headSha))
    throw new Error("legacy manifest head is not on upstream first-parent ancestry");
  const actual = git([
    "log",
    "--first-parent",
    "--max-count=500",
    "--format=%H%x09%s",
    manifest.selection.headSha,
  ])
    .split("\n")
    .map((line) => ({ sha: line.slice(0, 40), subject: line.slice(41) }));
  if (JSON.stringify(actual) !== JSON.stringify(manifest.commits))
    throw new Error("legacy manifest differs from upstream history");
  const subjects = new Map(
    git(["log", "--format=%H%x09%s", ledger.audit!.targetSha])
      .split("\n")
      .filter(Boolean)
      .map((line) => [line.slice(0, 40), line.slice(41)]),
  );
  const migrated = migrateLegacyLedger(ledger, subjects);
  assertValid(migrated, root);
  validateProvenance(migrated, git);
  return { expected: ledgerText, expectedManifest: manifestText, ledger: migrated };
}
