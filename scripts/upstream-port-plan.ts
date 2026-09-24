import {
  coveredInterval,
  sortEntries,
  validateAudit,
  SHA_PATTERN,
  REVIEW_PLACEHOLDER_PATTERN,
  type FrozenCommit,
  type Ledger,
  type LedgerEntry,
} from "./upstream-port-ledger.ts";

export interface PlannedCommit {
  readonly upstreamSha: string;
  readonly classification: string;
  readonly reason: string;
  readonly reviewStatus: "reviewed";
  readonly evidence?: ReadonlyArray<string>;
  readonly f5Shas?: ReadonlyArray<string>;
}
export interface PortPlan {
  readonly schemaVersion: 1;
  readonly baseSha: string;
  readonly targetSha: string;
  readonly entries: ReadonlyArray<PlannedCommit>;
}

const phases = new Set([
  "0a",
  "0b",
  "0c",
  "0d",
  "1a",
  "1b",
  "1c",
  "1d",
  "2",
  "3a",
  "3b",
  "3c",
  "3d",
  "3e",
  "3f",
  "4",
  "5",
  "6",
  "7a",
  "7b",
  "7c",
  "8a",
  "8b",
  "8c",
  "8d",
  "9a",
  "9b",
  "9c",
  "9d",
  "9e",
  "9f",
  "10",
  "11a",
  "11b",
  "11c",
  "12a",
  "12b",
  "13a",
  "13b",
  "13c",
  "13d",
  "14",
]);
const reasonKeys = new Set([
  "mobile",
  "relay-cloud",
  "multi-environment",
  "devices",
  "marketing",
  "release-ci",
  "maintenance",
]);

function classify(commit: FrozenCommit, decision: PlannedCommit): LedgerEntry {
  if (
    decision.reviewStatus !== "reviewed" ||
    typeof decision.reason !== "string" ||
    !decision.reason.trim() ||
    REVIEW_PLACEHOLDER_PATTERN.test(decision.reason)
  ) {
    throw new Error(`SHA ${commit.sha} requires an explicit reviewed decision and concrete reason`);
  }
  if (
    decision.evidence !== undefined &&
    (!Array.isArray(decision.evidence) ||
      decision.evidence.some((value) => typeof value !== "string"))
  )
    throw new Error(`invalid evidence for ${commit.sha}`);
  if (
    decision.f5Shas !== undefined &&
    (!Array.isArray(decision.f5Shas) || decision.f5Shas.some((sha) => !SHA_PATTERN.test(sha)))
  )
    throw new Error(`invalid f5Shas for ${commit.sha}`);
  const base = {
    upstreamSha: commit.sha,
    subject: commit.subject,
    reason: decision.reason,
    reviewStatus: "reviewed" as const,
    ...(decision.evidence ? { evidence: decision.evidence } : {}),
    ...(decision.f5Shas ? { f5Shas: decision.f5Shas } : {}),
  };
  const value = decision.classification;
  if (typeof value !== "string") throw new Error(`invalid classification for ${commit.sha}`);
  if (value.startsWith("planned:")) {
    const phase = value.slice("planned:".length);
    if (!phases.has(phase)) throw new Error(`invalid planned phase ${phase}`);
    return { ...base, disposition: "deferred", plannedWorkstream: phase };
  }
  if (value === "declined" || value === "deferred") return { ...base, disposition: value };
  if (value.startsWith("equivalent:")) {
    const evidence = value.slice("equivalent:".length);
    if (!evidence.trim() || !decision.f5Shas?.length)
      throw new Error(`equivalent SHA ${commit.sha} requires f5 evidence and implementation SHAs`);
    return {
      ...base,
      disposition: "equivalent",
      evidence: [...new Set([evidence, ...(decision.evidence ?? [])])],
    };
  }
  if (value.startsWith("not-applicable:")) {
    const key = value.slice("not-applicable:".length);
    if (!reasonKeys.has(key) && !/^upstream-only-subsystem:[a-z0-9-]+$/.test(key))
      throw new Error(`invalid not-applicable reason key ${key}`);
    return { ...base, disposition: "not-applicable" };
  }
  throw new Error(`invalid classification ${value} for ${commit.sha}`);
}

/** A plan is triage, never proof of implementation. Planned work stays deferred. */
export function applyPortPlan(
  ledger: Ledger,
  commits: ReadonlyArray<FrozenCommit>,
  plan: PortPlan,
): Ledger {
  if (ledger.schemaVersion !== 6)
    throw new Error("migrate the ledger to schema 6 before applying classifications");
  if (
    plan.schemaVersion !== 1 ||
    !SHA_PATTERN.test(plan.baseSha) ||
    !SHA_PATTERN.test(plan.targetSha) ||
    !Array.isArray(plan.entries)
  )
    throw new Error("invalid classification plan metadata");
  const errors = validateAudit(ledger);
  if (errors.length) throw new Error(errors.join("\n"));
  const covered = coveredInterval(ledger, plan.baseSha, plan.targetSha);
  if (JSON.stringify(covered) !== JSON.stringify(commits.map((commit) => commit.sha)))
    throw new Error("classification selection differs from already-covered interval");
  const expected = new Set(commits.map((commit) => commit.sha));
  if (expected.size !== commits.length) throw new Error("duplicate SHA in classification interval");
  const decisions = new Map<string, PlannedCommit>();
  for (const entry of plan.entries) {
    if (!entry || !SHA_PATTERN.test(entry.upstreamSha))
      throw new Error("classification contains an invalid SHA");
    if (decisions.has(entry.upstreamSha))
      throw new Error(`duplicate classification SHA ${entry.upstreamSha}`);
    decisions.set(entry.upstreamSha, entry);
  }
  const missing = [...expected].filter((sha) => !decisions.has(sha));
  const extra = [...decisions.keys()].filter((sha) => !expected.has(sha));
  if (missing.length || extra.length)
    throw new Error(
      `classification coverage mismatch; missing SHAs: ${missing.join(", ")}; extra SHAs: ${extra.join(", ")}`,
    );
  const existing = new Map(ledger.entries.map((entry) => [entry.upstreamSha, entry]));
  for (const commit of commits) {
    const entry = classify(commit, decisions.get(commit.sha)!);
    const previous = existing.get(commit.sha);
    // Regeneration must never erase a later implementation's proof.
    existing.set(
      commit.sha,
      previous && ["ported", "equivalent", "already-present"].includes(previous.disposition)
        ? previous
        : entry,
    );
  }
  return { ...ledger, entries: sortEntries(existing.values()) };
}
