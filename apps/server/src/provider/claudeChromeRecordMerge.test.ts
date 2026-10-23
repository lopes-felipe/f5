import { describe, expect, it } from "vitest";
import {
  INTEGRATION_REQUIRED_ASSERTIONS,
  PROVIDER_INTEGRATION_RECORDS,
  recordCertifies,
  type ClaudeChromeRecord,
  type IntegrationEvidenceReport,
} from "@t3tools/shared/providerIntegrationCertification";
import { mergeClaudeChromeRecords } from "./claudeChromeRecordMerge";

const base = PROVIDER_INTEGRATION_RECORDS["claude-chrome"][0]!;
const record: ClaudeChromeRecord = {
  ...base,
  id: "claude-chrome-darwin-arm64-9.9.9",
  versions: { ...base.versions, cliVersion: "9.9.9" },
};
const older: ClaudeChromeRecord = { ...base, id: "claude-chrome-darwin-arm64-1.0.0" };
const report: IntegrationEvidenceReport = {
  integration: "claude-chrome",
  evidenceId: "evidence-9",
  platform: record.platform,
  arch: record.arch,
  versions: { ...record.versions },
  assertions: Object.fromEntries(
    INTEGRATION_REQUIRED_ASSERTIONS["claude-chrome"].map((name) => [name, true]),
  ),
  toolNames: ["read_page"],
  artifactSha256: "a".repeat(64),
};
const stamped = mergeClaudeChromeRecords({ existing: [older], record, report });
const current = (records: ReadonlyArray<ClaudeChromeRecord>) =>
  records.find((entry) => entry.id === record.id)!;

describe("Claude in Chrome record merge", () => {
  it("stamps supported evidence with its artifact digest and keeps older records", () => {
    expect(stamped.map((entry) => entry.id)).toEqual([older.id, record.id]);
    expect(current(stamped)).toMatchObject({
      evidenceId: "evidence-9",
      toolNames: ["read_page"],
      artifactSha256: "a".repeat(64),
    });
    expect(recordCertifies(current(stamped))).toBe(true);
  });

  it("withdraws the current CLI's record, closing its gate", () => {
    const withdrawn = mergeClaudeChromeRecords({
      existing: stamped,
      record,
      withdraw: { id: record.id, reason: "Broke on SDK 9.9.10" },
    });
    expect(current(withdrawn).withdrawn).toBe("Broke on SDK 9.9.10");
    expect(recordCertifies(current(withdrawn))).toBe(false);
    // Regenerating keeps the withdrawal.
    expect(current(mergeClaudeChromeRecords({ existing: withdrawn, record })).withdrawn).toBe(
      "Broke on SDK 9.9.10",
    );
    expect(() =>
      mergeClaudeChromeRecords({ existing: [], record, withdraw: { id: "missing", reason: "x" } }),
    ).toThrow("No record missing");
  });

  it("never lifts a withdrawal as a side effect of new evidence", () => {
    const withdrawn = mergeClaudeChromeRecords({
      existing: stamped,
      record,
      withdraw: { id: record.id, reason: "Broke" },
    });
    expect(() => mergeClaudeChromeRecords({ existing: withdrawn, record, report })).toThrow(
      "--reinstate",
    );
    const reinstated = mergeClaudeChromeRecords({
      existing: withdrawn,
      record,
      report,
      reinstate: true,
    });
    expect(current(reinstated).withdrawn).toBeUndefined();
    expect(recordCertifies(current(reinstated))).toBe(true);
  });

  it("refuses evidence that does not support the record", () => {
    expect(() =>
      mergeClaudeChromeRecords({
        existing: [],
        record,
        report: { ...report, assertions: { ...report.assertions, "permission-mode": false } },
      }),
    ).toThrow("assertion permission-mode");
    expect(() =>
      mergeClaudeChromeRecords({
        existing: [],
        record,
        report: { ...report, versions: { ...report.versions, cliVersion: "1.0.0" } },
      }),
    ).toThrow("Evidence is for CLI 1.0.0");
  });
});
