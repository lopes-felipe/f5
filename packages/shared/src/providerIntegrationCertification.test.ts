import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  INTEGRATION_ACCEPTANCE_CHECKS,
  CODEX_CHROME_DRAIN_TOOL,
  INTEGRATION_REQUIRED_ASSERTIONS,
  PROVIDER_INTEGRATION_RECORDS,
  acceptanceMismatches,
  certifiedIntegrationRecord,
  codexParentIdentifierAllowed,
  integrationTemplateRecord,
  newestRecordsFirst,
  evidenceMismatches,
  integrationBrowserBundleIds,
  integrationUnavailableDetail,
  isIntegrationCertified,
  recordCertifies,
  type ClaudeChromeRecord,
  type CodexChromeRecord,
  type IntegrationAcceptanceReport,
  type IntegrationEvidenceReport,
  type ProviderIntegrationRecord,
} from "./providerIntegrationCertification";

const allRecords = Object.values(
  PROVIDER_INTEGRATION_RECORDS,
).flat() as ProviderIntegrationRecord[];
const claude = PROVIDER_INTEGRATION_RECORDS["claude-chrome"][0]!;
const certified: ClaudeChromeRecord = {
  ...claude,
  evidenceId: "evidence-1",
  toolNames: ["read_page"],
  evidenceCommit: "b".repeat(40),
};

describe("provider integration certification records", () => {
  it("accepts only OpenAI's Codex signing identifiers as node_repl's parent", () => {
    expect(codexParentIdentifierAllowed("codex")).toBe(true);
    expect(codexParentIdentifierAllowed("com.openai.codex.cli")).toBe(true);
    // The ChatGPT app itself and look-alikes are not a Codex parent.
    expect(codexParentIdentifierAllowed("com.openai.codex")).toBe(false);
    expect(codexParentIdentifierAllowed("codex-evil")).toBe(false);
    expect(codexParentIdentifierAllowed("node")).toBe(false);
  });

  it("has unique record ids", () => {
    expect(new Set(allRecords.map((record) => record.id)).size).toBe(allRecords.length);
  });

  it("cites only evidence reports that fully support the record", () => {
    for (const record of allRecords) {
      if (!record.evidenceId) continue;
      const path = new URL(
        `../../../docs/computer-certification/${record.evidenceId}.json`,
        import.meta.url,
      );
      expect(existsSync(path), `${record.id} cites ${record.evidenceId}`).toBe(true);
      // Every required assertion passed; versions, inventory and the clean commit match.
      const report = JSON.parse(readFileSync(path, "utf8")) as IntegrationEvidenceReport;
      expect(evidenceMismatches(record, report), record.id).toEqual([]);
    }
  });

  it("certifies only with evidence, its commit and a tool inventory, never when withdrawn", () => {
    expect(recordCertifies(claude)).toBe(claude.evidenceId !== undefined && !claude.withdrawn);
    expect(recordCertifies(certified)).toBe(true);
    expect(recordCertifies({ ...certified, toolNames: [] })).toBe(false);
    // Claude's admission needs the tool names; a digest alone is not enough.
    expect(
      recordCertifies({ ...certified, toolNames: [], toolInventorySha256: "a".repeat(64) }),
    ).toBe(false);
    const { evidenceCommit: _commit, ...uncommitted } = certified;
    expect(recordCertifies(uncommitted)).toBe(false);
    expect(recordCertifies({ ...certified, evidenceCommit: "abc123" })).toBe(false);
    expect(recordCertifies({ ...certified, withdrawn: "SDK 0.3.296" })).toBe(false);
  });

  it("certifies a Codex Chrome record only when the session could actually use it", () => {
    const codex = PROVIDER_INTEGRATION_RECORDS["codex-chrome"][0]!;
    const complete: CodexChromeRecord = {
      ...codex,
      versions: { appMin: "26.1016.62342", pluginMin: "26.1016.62342", codexMin: "0.163.0" },
      evidenceId: "evidence-2",
      evidenceCommit: "c".repeat(40),
      toolNames: [...codex.identity.allowedTools, CODEX_CHROME_DRAIN_TOOL],
      toolInventorySha256: "d".repeat(64),
      identity: { ...codex.identity, admission: "session" },
    };
    expect(recordCertifies(complete)).toBe(true);
    // Without the digest, Codex's inventory can't be verified.
    const { toolInventorySha256: _inventory, ...noDigest } = complete;
    expect(recordCertifies(noDigest)).toBe(false);
    // The drain hook is part of the inventory the session verifies.
    expect(recordCertifies({ ...complete, toolNames: [...codex.identity.allowedTools] })).toBe(
      false,
    );
    // Without a Codex floor, any Codex build would run it.
    expect(recordCertifies({ ...complete, versions: { appMin: "1", pluginMin: "1" } })).toBe(false);
    // This build runs session admission only.
    expect(
      recordCertifies({ ...complete, identity: { ...complete.identity, admission: "per-call" } }),
    ).toBe(false);
    const { admission: _admission, ...noAdmission } = complete.identity;
    expect(recordCertifies({ ...complete, identity: noAdmission })).toBe(false);
  });

  it("picks the highest certified floor at or below the installed version", () => {
    const codex = PROVIDER_INTEGRATION_RECORDS["codex-chrome"][0]!;
    const floor = (appMin: string, inventory: string): CodexChromeRecord => ({
      ...codex,
      id: `codex-chrome-darwin-arm64-${appMin}`,
      versions: { appMin, pluginMin: appMin, codexMin: "0.163.0" },
      evidenceId: `evidence-${appMin}`,
      evidenceCommit: "c".repeat(40),
      toolNames: [...codex.identity.allowedTools, CODEX_CHROME_DRAIN_TOOL],
      toolInventorySha256: inventory.repeat(64),
      identity: { ...codex.identity, admission: "session" },
    });
    // Id order ("26.1020…" < "26.999…") is not version order.
    const older = floor("26.999.1", "a");
    const newer = floor("26.1020.1", "b");
    const records = [newer, older];
    const pick = (version?: string) =>
      certifiedIntegrationRecord("codex-chrome", "darwin", "arm64", records, version)?.id;
    expect(pick("26.1030.0")).toBe(newer.id);
    expect(pick("26.1020.1")).toBe(newer.id);
    expect(pick("26.1019.9")).toBe(older.id);
    expect(pick("26.999.0")).toBeUndefined();
    expect(pick()).toBe(newer.id);
    expect(newestRecordsFirst([older, newer]).map((record) => record.id)).toEqual([
      newer.id,
      older.id,
    ]);
    // Withdrawn records are never a new run's template.
    expect(
      integrationTemplateRecord([{ ...newer, withdrawn: "x" }, older], "darwin", "arm64")?.id,
    ).toBe(older.id);
  });

  it("keeps every gate closed until a live run certifies a record", () => {
    for (const integration of ["claude-chrome", "codex-chrome", "codex-computer"] as const)
      expect(isIntegrationCertified(integration, "darwin", "arm64")).toBe(
        PROVIDER_INTEGRATION_RECORDS[integration].some(recordCertifies),
      );
  });

  it("matches the platform and architecture exactly", () => {
    expect(certifiedIntegrationRecord("claude-chrome", "darwin", "arm64", [certified])).toBe(
      certified,
    );
    expect(
      certifiedIntegrationRecord("claude-chrome", "darwin", "x64", [certified]),
    ).toBeUndefined();
    expect(
      certifiedIntegrationRecord("claude-chrome", "linux", "arm64", [certified]),
    ).toBeUndefined();
  });

  it("explains the specific reason a gate is closed", () => {
    expect(
      integrationUnavailableDetail("claude-chrome", "darwin", "arm64", [certified]),
    ).toBeUndefined();
    expect(integrationUnavailableDetail("claude-chrome", "darwin", "arm64", [claude])).toContain(
      "awaiting a live safety certification",
    );
    expect(integrationUnavailableDetail("claude-chrome", "darwin", "x64", [certified])).toContain(
      "architecture",
    );
    expect(integrationUnavailableDetail("claude-chrome", "win32", "x64", [certified])).toContain(
      "operating system",
    );
    expect(
      integrationUnavailableDetail("claude-chrome", "darwin", "arm64", [
        { ...claude, withdrawn: "SDK 0.3.296" },
      ]),
    ).toContain("withdrawn");
  });

  it("stamps evidence only when the scrubbed report supports the record", () => {
    const report = {
      integration: "claude-chrome" as const,
      evidenceId: "evidence-1",
      platform: "darwin",
      arch: "arm64",
      versions: { ...claude.versions },
      assertions: Object.fromEntries(
        INTEGRATION_REQUIRED_ASSERTIONS["claude-chrome"].map((name) => [name, true]),
      ),
      toolNames: ["read_page"],
      sourceCommit: "b".repeat(40),
      dirty: false,
    };
    expect(evidenceMismatches(certified, report)).toEqual([]);
    const { sourceCommit: _commit, ...uncommitted } = report;
    expect(evidenceMismatches(certified, uncommitted)).toEqual(["sourceCommit"]);
    // A report from a different commit never supports the record.
    expect(evidenceMismatches(certified, { ...report, sourceCommit: "e".repeat(40) })).toEqual([
      "sourceCommit",
    ]);
    expect(
      evidenceMismatches(
        { ...certified, evidenceCommit: "B".repeat(40) },
        { ...report, sourceCommit: "B".repeat(40) },
      ),
    ).toEqual(["sourceCommit"]);
    // Uncommitted changes, or a report that doesn't say, certify nothing.
    expect(evidenceMismatches(certified, { ...report, dirty: true })).toEqual(["dirty"]);
    const { dirty: _dirty, ...unknownTree } = report;
    expect(evidenceMismatches(certified, unknownTree)).toEqual(["dirty"]);
    expect(
      evidenceMismatches(certified, {
        ...report,
        versions: { ...report.versions, cliVersion: "9.9.9" },
      }),
    ).toEqual(["versions.cliVersion"]);
    expect(
      evidenceMismatches(certified, {
        ...report,
        assertions: { ...report.assertions, "write-ordering": false },
      }),
    ).toEqual(["assertion write-ordering"]);
    expect(evidenceMismatches(certified, { ...report, toolNames: ["read_page", "extra"] })).toEqual(
      ["toolNames"],
    );
  });

  it("requires Codex Chrome evidence for the record's admission mode and Codex floor", () => {
    const codex = PROVIDER_INTEGRATION_RECORDS["codex-chrome"][0]!;
    const record: CodexChromeRecord = {
      ...codex,
      versions: { appMin: "26.1016.62342", pluginMin: "26.1016.62342", codexMin: "0.163.0" },
      evidenceId: "evidence-3",
      evidenceCommit: "c".repeat(40),
      toolNames: [...codex.identity.allowedTools, CODEX_CHROME_DRAIN_TOOL],
      toolInventorySha256: "d".repeat(64),
      identity: { ...codex.identity, admission: "session" },
    };
    const report: IntegrationEvidenceReport = {
      integration: "codex-chrome",
      evidenceId: "evidence-3",
      platform: record.platform,
      arch: record.arch,
      versions: { ...record.versions },
      admission: "session",
      assertions: Object.fromEntries(
        INTEGRATION_REQUIRED_ASSERTIONS["codex-chrome"].map((name) => [name, true]),
      ),
      toolNames: record.toolNames!,
      toolInventorySha256: "d".repeat(64),
      sourceCommit: "c".repeat(40),
      dirty: false,
    };
    expect(evidenceMismatches(record, report)).toEqual([]);
    const { admission: _admission, ...withoutAdmission } = report;
    expect(evidenceMismatches(record, withoutAdmission)).toEqual(["admission"]);
    expect(
      evidenceMismatches(record, {
        ...report,
        versions: { ...report.versions, codexMin: "0.162.1" },
      }),
    ).toEqual(["versions.codexMin"]);
    // Session admission is certified by stopping on policy-off, and by the parent check.
    for (const assertion of ["policy-off-kills", "codex-parent-verified"])
      expect(
        evidenceMismatches(record, {
          ...report,
          assertions: { ...report.assertions, [assertion]: false },
        }),
      ).toEqual([`assertion ${assertion}`]);
  });

  it("accepts a release only for its exact artifact, records and passed checks", () => {
    const expected = {
      integration: "codex-chrome" as const,
      tag: "v1.2.3",
      artifactSha256: "f".repeat(64),
      recordIds: ["codex-chrome-darwin-arm64-26.1013.40934"],
    };
    const report: IntegrationAcceptanceReport = {
      kind: "acceptance",
      ...expected,
      platform: "darwin",
      arch: "arm64",
      artifactName: "F5-1.2.3-arm64.dmg",
      sourceCommit: "a".repeat(40),
      checks: Object.fromEntries(
        INTEGRATION_ACCEPTANCE_CHECKS["codex-chrome"].map((check) => [check.id, true]),
      ),
    };
    expect(acceptanceMismatches(report, expected)).toEqual([]);
    expect(acceptanceMismatches({ ...report, artifactSha256: "e".repeat(64) }, expected)).toEqual([
      "artifactSha256",
    ]);
    expect(acceptanceMismatches({ ...report, tag: "v1.2.2" }, expected)).toEqual(["tag"]);
    expect(acceptanceMismatches({ ...report, recordIds: [] }, expected)).toEqual(["recordIds"]);
    expect(
      acceptanceMismatches(
        { ...report, checks: { ...report.checks, "idle-stop": false } },
        expected,
      ),
    ).toEqual(["check idle-stop"]);
    const { checks: _checks, ...unchecked } = report;
    expect(acceptanceMismatches({ ...unchecked, checks: {} }, expected)).toHaveLength(
      INTEGRATION_ACCEPTANCE_CHECKS["codex-chrome"].length,
    );
  });

  it("gives every integration unique acceptance checks", () => {
    for (const checks of Object.values(INTEGRATION_ACCEPTANCE_CHECKS)) {
      expect(checks.length).toBeGreaterThan(0);
      expect(new Set(checks.map((check) => check.id)).size).toBe(checks.length);
    }
  });

  it("excludes every browser any record registers from native control", () => {
    const ids = integrationBrowserBundleIds();
    expect(ids).toContain("com.google.Chrome");
    for (const record of allRecords)
      for (const browser of record.browsers) expect(ids).toContain(browser.bundleId);
  });
});
