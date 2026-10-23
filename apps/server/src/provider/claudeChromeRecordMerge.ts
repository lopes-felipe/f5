import {
  evidenceMismatches,
  type ClaudeChromeRecord,
  type IntegrationEvidenceReport,
} from "@t3tools/shared/providerIntegrationCertification";

/**
 * Merges a freshly extracted Claude in Chrome record into the generated file.
 *
 * - Older records stay: journals reference them, and restore validates slots against the
 *   record that created them.
 * - Regenerating static facts keeps the same CLI version's stamp and any withdrawal.
 * - Evidence stamps only when the report supports the record, and never lifts a
 *   withdrawal unless `reinstate` is set.
 * - `withdraw` applies after the merge, so the current CLI's record can be withdrawn too:
 *   that is the emergency off-switch that needs no SDK change.
 */
export function mergeClaudeChromeRecords(input: {
  readonly existing: ReadonlyArray<ClaudeChromeRecord>;
  readonly record: ClaudeChromeRecord;
  readonly report?: IntegrationEvidenceReport;
  readonly reinstate?: boolean;
  readonly withdraw?: { readonly id: string; readonly reason: string };
}): ClaudeChromeRecord[] {
  const { existing, report, withdraw } = input;
  let record = input.record;
  const previous = existing.find((entry) => entry.id === record.id);
  const sameCli = previous?.versions.cliVersion === record.versions.cliVersion;
  if (report) {
    if (report.versions.cliVersion !== record.versions.cliVersion)
      throw new Error(
        `Evidence is for CLI ${report.versions.cliVersion}, not ${record.versions.cliVersion}.`,
      );
    if (previous?.withdrawn && !input.reinstate)
      throw new Error(
        `${record.id} is withdrawn (${previous.withdrawn}). Pass --reinstate to stamp it again.`,
      );
    const stamped: ClaudeChromeRecord = {
      ...record,
      evidenceId: report.evidenceId,
      ...(report.toolNames ? { toolNames: report.toolNames } : {}),
      ...(report.artifactSha256 ? { artifactSha256: report.artifactSha256 } : {}),
    };
    const problems = evidenceMismatches(stamped, report);
    if (problems.length)
      throw new Error(`Evidence does not support the record: ${problems.join(", ")}`);
    record = stamped;
  } else if (previous && sameCli) {
    record = {
      ...record,
      ...(previous.evidenceId ? { evidenceId: previous.evidenceId } : {}),
      ...(previous.toolNames ? { toolNames: previous.toolNames } : {}),
      ...(previous.artifactSha256 ? { artifactSha256: previous.artifactSha256 } : {}),
      ...(previous.withdrawn ? { withdrawn: previous.withdrawn } : {}),
    };
  }
  if (withdraw && withdraw.id !== record.id && !existing.some((entry) => entry.id === withdraw.id))
    throw new Error(`No record ${withdraw.id} to withdraw.`);
  return [...existing.filter((entry) => entry.id !== record.id), record]
    .map((entry) => (entry.id === withdraw?.id ? { ...entry, withdrawn: withdraw.reason } : entry))
    .sort((a, b) => a.id.localeCompare(b.id, "en"));
}
