import { describe, expect, it } from "vitest";
import {
  INTEGRATION_CAPABILITY_ASSERTIONS,
  INTEGRATION_REQUIRED_ASSERTIONS,
  PROVIDER_INTEGRATION_RECORDS,
  claudeChromeSupportsIsolatedProfiles,
  evidenceMismatches,
  recordCertifies,
  type ClaudeChromeRecord,
  type CodexChromeRecord,
  type CodexComputerRecord,
  type IntegrationEvidenceReport,
} from "@t3tools/shared/providerIntegrationCertification";
import {
  claudeRecordWithFloors,
  codexRecordFromEvidence,
  coveringClaudeChromeRecord,
  mergeIntegrationRecords,
} from "./integrationRecordMerge";

const COMMIT = "a".repeat(40);
const base = PROVIDER_INTEGRATION_RECORDS["claude-chrome"][0]!;
const record: ClaudeChromeRecord = {
  ...base,
  id: "claude-chrome-darwin-arm64-9.9.9",
  versions: { ...base.versions, cliMin: "9.9.9" },
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
        report: {
          ...report,
          assertions: { ...report.assertions, "terminal-claude-unaffected": false },
        },
      }),
    ).toThrow("assertion terminal-claude-unaffected");
    expect(() =>
      mergeIntegrationRecords({
        existing: [],
        record,
        report: { ...report, versions: { ...report.versions, cliMin: "1.0.0" } },
      }),
    ).toThrow("versions.cliMin");
    expect(() =>
      mergeIntegrationRecords({ existing: [], record, report: { ...report, dirty: true } }),
    ).toThrow("dirty");
  });

  it("claims the isolated-profiles capability only when all its assertions passed", () => {
    const isolated = Object.fromEntries(
      INTEGRATION_CAPABILITY_ASSERTIONS["isolated-profiles"].map((name) => [name, true]),
    );
    expect(current(stamped).capabilities).toBeUndefined();
    const capable = current(
      mergeIntegrationRecords({
        existing: [older],
        record,
        report: { ...report, assertions: { ...report.assertions, ...isolated } },
      }),
    );
    expect(capable.capabilities).toEqual(["isolated-profiles"]);
    expect(claudeChromeSupportsIsolatedProfiles(capable)).toBe(true);
    // Regenerating keeps it; restamping from a run without the phase drops it.
    expect(current(mergeIntegrationRecords({ existing: [capable], record })).capabilities).toEqual([
      "isolated-profiles",
    ]);
    expect(
      current(mergeIntegrationRecords({ existing: [capable], record, report })).capabilities,
    ).toBeUndefined();
    const partial = current(
      mergeIntegrationRecords({
        existing: [],
        record,
        report: {
          ...report,
          assertions: { ...report.assertions, ...isolated, "isolated-restore": false },
        },
      }),
    );
    expect(partial.capabilities).toBeUndefined();
    expect(evidenceMismatches(capable, report)).toEqual([
      "capability isolated-profiles: assertion isolated-projection",
      "capability isolated-profiles: assertion isolated-read-only-call",
      "capability isolated-profiles: assertion isolated-restore",
    ]);
    // A capability never makes a covered CLI need a new record.
    expect(
      coveringClaudeChromeRecord([capable], { ...record, versions: { ...record.versions } }),
    ).toBe(capable);
  });
});

describe("Claude in Chrome floors", () => {
  const { withdrawn: _withdrawn, ...current } = base;
  const legacy = {
    ...current,
    versions: { sdkVersion: "0.3.295", cliVersion: "2.1.295" },
  } as ClaudeChromeRecord;
  const candidate = (patch: Partial<ClaudeChromeRecord> = {}): ClaudeChromeRecord => ({
    ...base,
    id: "claude-chrome-darwin-arm64-2.1.400",
    versions: { sdkMin: "0.3.400", cliMin: "2.1.400" },
    ...patch,
  });
  const floor = claudeRecordWithFloors(legacy);

  it("reads legacy exact versions as floors", () => {
    expect(floor.versions).toEqual({ sdkMin: "0.3.295", cliMin: "2.1.295" });
    expect(claudeRecordWithFloors(floor)).toEqual(floor);
  });

  it("covers a newer CLI with an unchanged descriptor, and nothing else", () => {
    expect(coveringClaudeChromeRecord([floor], candidate())).toBe(floor);
    // Key order in the stored identity doesn't matter.
    const reordered = {
      ...floor,
      identity: Object.fromEntries(Object.entries(floor.identity).reverse()),
    } as ClaudeChromeRecord;
    expect(coveringClaudeChromeRecord([reordered], candidate())).toBe(reordered);
    expect(
      coveringClaudeChromeRecord(
        [floor],
        candidate({ identity: { ...base.identity, hostName: "com.anthropic.other" } }),
      ),
    ).toBeUndefined();
    expect(
      coveringClaudeChromeRecord([floor], candidate({ browsers: base.browsers.slice(1) })),
    ).toBeUndefined();
    expect(
      coveringClaudeChromeRecord(
        [floor],
        candidate({ versions: { sdkMin: "0.3.100", cliMin: "2.1.100" } }),
      ),
    ).toBeUndefined();
  });

  it("keeps a withdrawn covering record in force instead of adding an unstamped one", () => {
    // The record the runtime selects, as `claudeChromeRecordFor` does: withdrawn included.
    const withdrawn = { ...floor, withdrawn: "Withdrawn" };
    expect(coveringClaudeChromeRecord([withdrawn], candidate())).toBe(withdrawn);
    const newer = {
      ...floor,
      id: "claude-chrome-darwin-arm64-2.1.350",
      versions: { sdkMin: "0.3.350", cliMin: "2.1.350" },
    };
    // A withdrawn newer floor shadows the older one; the candidate falls under it.
    expect(coveringClaudeChromeRecord([floor, { ...newer, withdrawn: "W" }], candidate())?.id).toBe(
      newer.id,
    );
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
    versions: { appMin: "26.1020.5", pluginMin: "26.1020.5", codexMin: "0.163.0" },
    admission: "session",
    assertions: Object.fromEntries(
      INTEGRATION_REQUIRED_ASSERTIONS["codex-chrome"].map((name) => [name, true]),
    ),
    toolNames: ["js", "js_reset", "turn_ended"],
    toolInventorySha256: "d".repeat(64),
    toolSchemas: [
      { name: "js", description: "Run JavaScript", inputSchema: schema },
      { name: "js_reset", inputSchema: { type: "object" } },
      { name: "turn_ended", inputSchema: { type: "object" } },
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

  it("writes the exercised versions, the Codex one included, as floors with no ceiling", () => {
    expect(floor.id).toBe("codex-chrome-darwin-arm64-26.1020.5");
    expect(floor.versions).toEqual({
      appMin: "26.1020.5",
      pluginMin: "26.1020.5",
      codexMin: "0.163.0",
    });
    expect(floor.evidenceId).toBeUndefined();
  });

  it("stamps the inventory and keeps the template's admission mode", () => {
    const stampedRecord = current(merged, floor.id) as CodexChromeRecord;
    expect(stampedRecord).toMatchObject({
      evidenceId: "codex-evidence",
      evidenceCommit: COMMIT,
      toolNames: ["js", "js_reset", "turn_ended"],
      toolInventorySha256: "d".repeat(64),
      identity: { admission: "session" },
    });
    expect(recordCertifies(stampedRecord)).toBe(true);
    // The template record stays for restore.
    expect(merged.map((entry) => entry.id)).toContain(template.id);
    // The stamped record round-trips through the stamper's own check.
    expect(evidenceMismatches(stampedRecord, codexReport)).toEqual([]);
  });

  it("refuses evidence for another admission mode", () => {
    expect(() =>
      mergeIntegrationRecords({
        existing: [],
        record: floor,
        report: { ...codexReport, admission: "per-call" },
      }),
    ).toThrow("admission");
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
