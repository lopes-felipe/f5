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

export interface Audit {
  readonly baseSha: string;
  readonly targetSha: string;
  readonly selection: "first-parent";
  readonly count: number;
  readonly digest: string;
  // Newest first, excluding baseSha. Frozen here so offline validation still checks
  // set equality and ordering; an available upstream independently verifies it.
  readonly upstreamShas: ReadonlyArray<string>;
}

export interface Ledger {
  readonly schemaVersion: 4 | 5;
  readonly manifest: "scripts/upstream-ports.manifest.json";
  readonly manifestSha256: string;
  readonly entries: ReadonlyArray<LedgerEntry>;
  readonly historicalEntries?: ReadonlyArray<LedgerEntry>;
  readonly olderBacklog: ReadonlyArray<OlderBacklogCategory>;
  readonly audit?: Audit;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function makeAudit(
  baseSha: string,
  targetSha: string,
  upstreamShas: ReadonlyArray<string>,
): Audit {
  return {
    baseSha,
    targetSha,
    selection: "first-parent",
    count: upstreamShas.length,
    digest: sha256(upstreamShas.join("\n") + "\n"),
    upstreamShas,
  };
}

export function migrateEntries(ledger: Ledger): LedgerEntry[] {
  return [...ledger.entries, ...(ledger.historicalEntries ?? [])].map((entry) =>
    ledger.schemaVersion === 4 ? { ...entry, reviewStatus: "legacy" } : entry,
  );
}

/** Retain the category as provenance, but count promoted SHAs only in their records. */
export function promoteBacklog(
  categories: ReadonlyArray<OlderBacklogCategory>,
  promoted: ReadonlySet<string>,
): OlderBacklogCategory[] {
  return categories.map((category) => {
    const moved = (category.upstreamShas ?? []).filter((sha) => promoted.has(sha));
    return {
      ...category,
      ...(category.upstreamShas
        ? { upstreamShas: category.upstreamShas.filter((sha) => !promoted.has(sha)) }
        : {}),
      ...(moved.length
        ? {
            promotedUpstreamShas: [
              ...new Set([...(category.promotedUpstreamShas ?? []), ...moved]),
            ],
          }
        : {}),
    };
  });
}

export function refreshEntries(
  ledger: Ledger,
  commits: ReadonlyArray<FrozenCommit>,
  suggest: (commit: FrozenCommit) => LedgerEntry,
): Pick<Ledger, "entries" | "historicalEntries" | "olderBacklog"> {
  const records = migrateEntries(ledger);
  const previous = new Map(records.map((entry) => [entry.upstreamSha, entry]));
  if (previous.size !== records.length) throw new Error("duplicate SHA in previous ledger records");
  const window = new Set(commits.map((commit) => commit.sha));
  // A legacy exact-SHA category may move back into the window on a pinned refresh.
  // Retain its provenance without allowing a SHA to appear in both locations.
  for (const category of ledger.olderBacklog) {
    for (const sha of category.upstreamShas ?? []) {
      if (previous.has(sha)) throw new Error(`duplicate SHA in previous ledger: ${sha}`);
      previous.set(sha, {
        upstreamSha: sha,
        subject: "",
        disposition: category.disposition,
        reason: category.reason,
        reviewStatus: "legacy",
        ...(category.f5Shas ? { f5Shas: category.f5Shas } : {}),
        ...(category.evidence ? { evidence: category.evidence } : {}),
      });
    }
  }
  return {
    entries: commits.map((commit) => {
      const existing = previous.get(commit.sha);
      return existing ? { ...existing, subject: commit.subject } : suggest(commit);
    }),
    historicalEntries: records.filter((entry) => !window.has(entry.upstreamSha)),
    olderBacklog: promoteBacklog(ledger.olderBacklog, window),
  };
}

export function validateAudit(ledger: Ledger): string[] {
  const errors: string[] = [];
  const audit = ledger.audit;
  if (!audit || !Array.isArray(audit.upstreamShas))
    return ["schema 5 requires frozen audit metadata"];
  if (!SHA_PATTERN.test(audit.baseSha) || !SHA_PATTERN.test(audit.targetSha))
    errors.push("invalid audit boundary SHA");
  if (audit.selection !== "first-parent") errors.push("audit selection must be first-parent");
  const expected = new Set(audit.upstreamShas);
  if (expected.size !== audit.upstreamShas.length) errors.push("duplicate SHA in audit selection");
  if (audit.upstreamShas.some((sha) => !SHA_PATTERN.test(sha)))
    errors.push("invalid SHA in audit selection");
  if (audit.count !== audit.upstreamShas.length)
    errors.push("audit count differs from frozen selection");
  if (audit.upstreamShas[0] !== audit.targetSha || expected.has(audit.baseSha))
    errors.push("audit boundaries differ from frozen selection");
  if (audit.digest !== makeAudit(audit.baseSha, audit.targetSha, audit.upstreamShas).digest)
    errors.push("audit digest differs from ordered SHA list");
  const seen = new Set<string>();
  const extra: string[] = [];
  for (const entry of [...ledger.entries, ...(ledger.historicalEntries ?? [])]) {
    if (seen.has(entry.upstreamSha))
      errors.push(`duplicate audit coverage SHA ${entry.upstreamSha}`);
    seen.add(entry.upstreamSha);
    if (!expected.has(entry.upstreamSha) && entry.reviewStatus !== "legacy")
      extra.push(entry.upstreamSha);
  }
  // Legacy categories deliberately retain older provenance outside this audit.
  for (const category of ledger.olderBacklog) {
    for (const sha of category.upstreamShas ?? []) {
      if (seen.has(sha)) errors.push(`duplicate audit coverage SHA ${sha}`);
      seen.add(sha);
    }
  }
  const missing = audit.upstreamShas.filter((sha) => !seen.has(sha));
  if (missing.length) errors.push(`missing audit SHAs: ${missing.join(", ")}`);
  if (extra.length) errors.push(`extra audit SHAs: ${extra.join(", ")}`);
  return errors;
}
