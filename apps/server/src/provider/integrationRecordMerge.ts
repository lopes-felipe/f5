import {
  evidenceMismatches,
  recordForVersion,
  reportCapabilities,
  type ClaudeChromeRecord,
  type CodexChromeRecord,
  type CodexComputerRecord,
  type IntegrationEvidenceReport,
  type ProviderIntegrationRecord,
} from "@t3tools/shared/providerIntegrationCertification";

type CodexRecord = CodexChromeRecord | CodexComputerRecord;

/** Fields only evidence may set; a template or regenerated record never carries them. */
function withoutStamp<R extends ProviderIntegrationRecord>(record: R): R {
  const {
    evidenceId: _evidenceId,
    evidenceCommit: _evidenceCommit,
    toolNames: _toolNames,
    toolInventorySha256: _toolInventorySha256,
    withdrawn: _withdrawn,
    ...rest
  } = record;
  // Capabilities are evidence too: they come only from the report that stamped the record.
  if ("capabilities" in rest) delete (rest as { capabilities?: unknown }).capabilities;
  return rest as R;
}

/** What a supporting report adds to the record it certifies. */
function stamp<R extends ProviderIntegrationRecord>(
  record: R,
  report: IntegrationEvidenceReport,
): R {
  return {
    ...record,
    evidenceId: report.evidenceId,
    ...(report.sourceCommit ? { evidenceCommit: report.sourceCommit } : {}),
    ...(report.toolNames ? { toolNames: report.toolNames } : {}),
    ...(record.integration !== "claude-chrome" && report.toolInventorySha256
      ? { toolInventorySha256: report.toolInventorySha256 }
      : {}),
    ...(record.integration === "claude-chrome" && reportCapabilities(report).length
      ? { capabilities: reportCapabilities(report) }
      : {}),
  };
}

/**
 * A Codex record certified from a live run: the template's static identity with the
 * exercised versions as floors (`*Min`, no `*Max`), named for the app floor. Non-version
 * facts in `versions` (Sky's paths) come from the template.
 */
export function codexRecordFromEvidence<R extends CodexRecord>(
  template: R,
  report: IntegrationEvidenceReport,
): R {
  if (report.integration !== template.integration)
    throw new Error(`Evidence is for ${report.integration}, not ${template.integration}.`);
  if (report.platform !== template.platform || report.arch !== template.arch)
    throw new Error(`Evidence is for ${report.platform}-${report.arch}.`);
  const isRange = (key: string) => key.endsWith("Min") || key.endsWith("Max");
  const floors = Object.fromEntries(
    Object.entries(report.versions).filter(([key]) => key.endsWith("Min")),
  );
  const appMin = floors.appMin;
  if (!appMin) throw new Error("Evidence does not name the exercised app version (appMin).");
  const facts = Object.fromEntries(
    Object.entries(template.versions).filter(([key]) => !isRange(key)),
  );
  return {
    ...withoutStamp(template),
    id: `${template.integration}-${template.platform}-${template.arch}-${appMin}`,
    versions: { ...facts, ...floors },
  };
}

/** Claude records held exact `sdkVersion`/`cliVersion` before floors; both read as floors. */
export function claudeRecordWithFloors(record: ClaudeChromeRecord): ClaudeChromeRecord {
  const { sdkVersion, cliVersion, ...rest } = record.versions;
  return {
    ...record,
    versions: {
      ...(sdkVersion ? { sdkMin: sdkVersion } : {}),
      ...(cliVersion ? { cliMin: cliVersion } : {}),
      ...rest,
    },
  };
}

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b, "en")))
      : entry,
  );

/**
 * The existing record that already covers a freshly extracted `candidate`: the one the
 * runtime selects for its SDK (`claudeChromeRecordFor`'s rule, withdrawn records
 * included), when its static identity, browsers and profile isolation are unchanged. A
 * covered CLI needs no new record (or live run); any descriptor change needs one. A
 * withdrawn covering record keeps the CLI off until new evidence is stamped.
 */
export function coveringClaudeChromeRecord(
  existing: ReadonlyArray<ClaudeChromeRecord>,
  candidate: ClaudeChromeRecord,
): ClaudeChromeRecord | undefined {
  const sdk = candidate.versions.sdkMin;
  const selected =
    sdk === undefined
      ? undefined
      : recordForVersion(
          existing.filter(
            (record) => record.platform === candidate.platform && record.arch === candidate.arch,
          ),
          sdk,
        );
  if (!selected) return undefined;
  const statics = (record: ClaudeChromeRecord) =>
    canonical([record.identity, record.browsers, record.profileIsolation]);
  return statics(selected) === statics(candidate) ? selected : undefined;
}

/**
 * Merges a record into its generated file.
 *
 * - Older records stay: journals reference them, and restore validates slots against the
 *   record that created them.
 * - Regenerating static facts (same id, no report) keeps that record's stamp and any
 *   withdrawal.
 * - Evidence stamps only when the report supports the record, and never lifts a
 *   withdrawal unless `reinstate` is set.
 * - `withdraw` applies after the merge, so the current record can be withdrawn too: that
 *   is the emergency off-switch that needs no provider change. Without `record`, only the
 *   withdrawal is applied.
 */
export function mergeIntegrationRecords<R extends ProviderIntegrationRecord>(input: {
  readonly existing: ReadonlyArray<R>;
  readonly record?: R;
  readonly report?: IntegrationEvidenceReport;
  readonly reinstate?: boolean;
  readonly withdraw?: { readonly id: string; readonly reason: string };
}): R[] {
  const { existing, report, withdraw } = input;
  let record = input.record;
  if (report && !record) throw new Error("Evidence needs a record to stamp.");
  if (record) {
    const previous = existing.find((entry) => entry.id === record!.id);
    if (report) {
      if (previous?.withdrawn && !input.reinstate)
        throw new Error(
          `${record.id} is withdrawn (${previous.withdrawn}). Pass --reinstate to stamp it again.`,
        );
      const stamped = stamp(withoutStamp(record), report);
      const problems = evidenceMismatches(stamped, report);
      if (problems.length)
        throw new Error(`Evidence does not support the record: ${problems.join(", ")}`);
      record = stamped;
    } else if (previous) {
      const kept = withoutStamp(record);
      record = {
        ...kept,
        ...(previous.evidenceId ? { evidenceId: previous.evidenceId } : {}),
        ...(previous.evidenceCommit ? { evidenceCommit: previous.evidenceCommit } : {}),
        ...(previous.toolNames ? { toolNames: previous.toolNames } : {}),
        ...(previous.toolInventorySha256
          ? { toolInventorySha256: previous.toolInventorySha256 }
          : {}),
        ...("capabilities" in previous && previous.capabilities
          ? { capabilities: previous.capabilities }
          : {}),
        ...(previous.withdrawn ? { withdrawn: previous.withdrawn } : {}),
      } as R;
    }
  }
  if (withdraw && withdraw.id !== record?.id && !existing.some((entry) => entry.id === withdraw.id))
    throw new Error(`No record ${withdraw.id} to withdraw.`);
  const merged = record
    ? [...existing.filter((entry) => entry.id !== record!.id), record]
    : [...existing];
  return merged
    .map((entry) => (entry.id === withdraw?.id ? { ...entry, withdrawn: withdraw.reason } : entry))
    .sort((a, b) => a.id.localeCompare(b.id, "en"));
}
