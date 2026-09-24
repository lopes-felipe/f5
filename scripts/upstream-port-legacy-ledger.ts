import {
  SHA_PATTERN,
  makeAudit,
  type LedgerEntry,
  type OlderBacklogCategory,
  type Audit,
} from "./upstream-port-ledger.ts";
export interface LegacyLedger {
  readonly schemaVersion: 5;
  readonly manifest: "scripts/upstream-ports.manifest.json";
  readonly manifestSha256: string;
  readonly entries: ReadonlyArray<LedgerEntry>;
  readonly historicalEntries?: ReadonlyArray<LedgerEntry>;
  readonly olderBacklog: ReadonlyArray<OlderBacklogCategory>;
  readonly audit?: Audit;
}

export function validateLegacyAudit(
  ledger: LegacyLedger,
  additionalCoverage: ReadonlySet<string> = new Set(),
): string[] {
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
    if (
      !expected.has(entry.upstreamSha) &&
      !additionalCoverage.has(entry.upstreamSha) &&
      entry.reviewStatus !== "legacy"
    )
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
