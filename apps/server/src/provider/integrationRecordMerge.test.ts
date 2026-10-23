import { describe, expect, it } from "vitest";
import {
  INTEGRATION_REQUIRED_ASSERTIONS,
  PROVIDER_INTEGRATION_RECORDS,
  recordCertifies,
  type ClaudeChromeRecord,
  type CodexChromeRecord,
  type CodexComputerRecord,
  type IntegrationEvidenceReport,
} from "@t3tools/shared/providerIntegrationCertification";
import { codexRecordFromEvidence, mergeIntegrationRecords } from "./integrationRecordMerge";

const COMMIT = "a".repeat(40);
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
  sourceCommit: COMMIT,
  dirty: false,
};
const stamped = mergeIntegrationRecords({ existing: [older], record, report });
const current = <R extends { id: string }>(records: ReadonlyArray<R>, id = record.id) =>
  records.find((entry) => entry.id === id)!;

describe("Claude in Chrome record merge", () => {
  it("stamps supported evidence with its commit and keeps older records", () => {
    expect(stamped.map((entry) => entry.id)).toEqual([older.id, record.id]);
    expect(current(stamped)).toMatchObject({
      evidenceId: "evidence-9",
      toolNames: ["read_page"],
      evidenceCommit: COMMIT,
    });
    expect(recordCertifies(current(stamped))).toBe(true);
    // Regenerating the same CLI's static facts keeps the stamp.
    expect(current(mergeIntegrationRecords({ existing: stamped, record }))).toEqual(
      current(stamped),
    );
  });

  it("withdraws the current CLI's record, closing its gate", () => {
    const withdrawn = mergeIntegrationRecords({
      existing: stamped,
      record,
      withdraw: { id: record.id, reason: "Broke on SDK 9.9.10" },
    });
    expect(current(withdrawn).withdrawn).toBe("Broke on SDK 9.9.10");
    expect(recordCertifies(current(withdrawn))).toBe(false);
    // Regenerating keeps the withdrawal.
    expect(current(mergeIntegrationRecords({ existing: withdrawn, record })).withdrawn).toBe(
      "Broke on SDK 9.9.10",
    );
    expect(() =>
      mergeIntegrationRecords({ existing: [], record, withdraw: { id: "missing", reason: "x" } }),
    ).toThrow("No record missing");
  });

  it("never lifts a withdrawal as a side effect of new evidence", () => {
    const withdrawn = mergeIntegrationRecords({
      existing: stamped,
      record,
      withdraw: { id: record.id, reason: "Broke" },
    });
    expect(() => mergeIntegrationRecords({ existing: withdrawn, record, report })).toThrow(
      "--reinstate",
    );
    const reinstated = mergeIntegrationRecords({
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
      mergeIntegrationRecords({
        existing: [],
        record,
        report: { ...report, assertions: { ...report.assertions, "permission-mode": false } },
      }),
    ).toThrow("assertion permission-mode");
    expect(() =>
      mergeIntegrationRecords({
        existing: [],
        record,
        report: { ...report, versions: { ...report.versions, cliVersion: "1.0.0" } },
      }),
    ).toThrow("versions.cliVersion");
    expect(() =>
      mergeIntegrationRecords({ existing: [], record, report: { ...report, dirty: true } }),
    ).toThrow("dirty");
  });
});

describe("Codex record stamping", () => {
  const template = PROVIDER_INTEGRATION_RECORDS["codex-chrome"][0]!;
  const schema = { type: "object", properties: { code: { type: "string" } } };
  const codexReport: IntegrationEvidenceReport = {
    integration: "codex-chrome",
    evidenceId: "codex-evidence",
    platform: template.platform,
    arch: template.arch,
    versions: { appMin: "26.1020.5", pluginMin: "26.1020.5" },
    assertions: Object.fromEntries(
      INTEGRATION_REQUIRED_ASSERTIONS["codex-chrome"].map((name) => [name, true]),
    ),
    toolNames: ["js", "js_reset", "other"],
    toolInventorySha256: "d".repeat(64),
    toolSchemas: [
      { name: "js", description: "Run JavaScript", inputSchema: schema },
      { name: "js_reset", inputSchema: { type: "object" } },
      { name: "other", inputSchema: { type: "object" } },
    ],
    sourceCommit: COMMIT,
    dirty: false,
  };
  const floor = codexRecordFromEvidence(template, codexReport);
  const merged = mergeIntegrationRecords({
    existing: [template],
    record: floor,
    report: codexReport,
  });

  it("writes the exercised versions as floors with no ceiling", () => {
    expect(floor.id).toBe("codex-chrome-darwin-arm64-26.1020.5");
    expect(floor.versions).toEqual({ appMin: "26.1020.5", pluginMin: "26.1020.5" });
    expect(floor.evidenceId).toBeUndefined();
  });

  it("stamps the inventory and advertises only the allowed tools, verbatim", () => {
    const stampedRecord = current(merged, floor.id) as CodexChromeRecord;
    expect(stampedRecord).toMatchObject({
      evidenceId: "codex-evidence",
      evidenceCommit: COMMIT,
      toolInventorySha256: "d".repeat(64),
    });
    expect(stampedRecord.identity.advertisedTools).toEqual([
      { name: "js", description: "Run JavaScript", inputSchema: schema },
      { name: "js_reset", inputSchema: { type: "object" } },
    ]);
    expect(recordCertifies(stampedRecord)).toBe(true);
    // The template record stays for restore.
    expect(merged.map((entry) => entry.id)).toContain(template.id);
  });

  it("refuses evidence without every allowed tool's schema", () => {
    expect(() =>
      mergeIntegrationRecords({
        existing: [],
        record: floor,
        report: { ...codexReport, toolSchemas: codexReport.toolSchemas!.slice(1) },
      }),
    ).toThrow("no schema for the allowed tool js");
  });

  it("withdraws a stamped floor without a new record", () => {
    const withdrawn = mergeIntegrationRecords({
      existing: merged,
      withdraw: { id: floor.id, reason: "Behaviour regressed in 26.1030" },
    });
    expect(recordCertifies(current(withdrawn, floor.id))).toBe(false);
    expect(withdrawn).toHaveLength(merged.length);
  });

  it("keeps Sky's non-version facts and drops any ceiling", () => {
    const sky: CodexComputerRecord = {
      integration: "codex-computer",
      id: "codex-computer-spike",
      platform: "darwin",
      arch: "arm64",
      versions: {
        appMin: "26.1",
        appMax: "26.1",
        serviceMin: "1.0",
        serviceAppPath: "Library/Sky.app",
        clientPath: "Contents/MacOS/client",
      },
      identity: {
        teamId: "2DC432GLL2",
        appIdentifier: "com.openai.codex",
        serviceIdentifier: "com.openai.sky.CUAService",
        mcpServerName: "computer-use",
      },
      browsers: [],
      profileIsolation: "shared-disclosed",
    };
    const skyFloor = codexRecordFromEvidence(sky, {
      ...codexReport,
      integration: "codex-computer",
      versions: { appMin: "26.2", serviceMin: "1.1" },
    });
    expect(skyFloor.versions).toEqual({
      serviceAppPath: "Library/Sky.app",
      clientPath: "Contents/MacOS/client",
      appMin: "26.2",
      serviceMin: "1.1",
    });
    expect(() =>
      codexRecordFromEvidence(sky, { ...codexReport, integration: "codex-computer", versions: {} }),
    ).toThrow("appMin");
    expect(() => codexRecordFromEvidence(sky, codexReport)).toThrow("codex-chrome");
  });
});
