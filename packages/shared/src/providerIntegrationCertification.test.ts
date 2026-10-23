import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  INTEGRATION_REQUIRED_ASSERTIONS,
  PROVIDER_INTEGRATION_RECORDS,
  certifiedIntegrationRecord,
  evidenceMismatches,
  integrationBrowserBundleIds,
  integrationUnavailableDetail,
  isIntegrationCertified,
  recordCertifies,
  type ClaudeChromeRecord,
  type CodexChromeRecord,
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
  artifactSha256: "b".repeat(64),
};

describe("provider integration certification records", () => {
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
      // Every required assertion passed, versions, inventory and artifact digest match.
      const report = JSON.parse(readFileSync(path, "utf8")) as IntegrationEvidenceReport;
      expect(evidenceMismatches(record, report), record.id).toEqual([]);
    }
  });

  it("certifies only with evidence, an artifact digest and a tool inventory, never when withdrawn", () => {
    expect(recordCertifies(claude)).toBe(claude.evidenceId !== undefined && !claude.withdrawn);
    expect(recordCertifies(certified)).toBe(true);
    expect(recordCertifies({ ...certified, toolNames: [] })).toBe(false);
    // Claude's admission needs the tool names; a digest alone is not enough.
    expect(
      recordCertifies({ ...certified, toolNames: [], toolInventorySha256: "a".repeat(64) }),
    ).toBe(false);
    const { artifactSha256: _digest, ...undigested } = certified;
    expect(recordCertifies(undigested)).toBe(false);
    expect(recordCertifies({ ...certified, withdrawn: "SDK 0.3.296" })).toBe(false);
  });

  it("certifies a Codex Chrome record only when the proxy could actually use it", () => {
    const codex = PROVIDER_INTEGRATION_RECORDS["codex-chrome"][0]!;
    const schema = { type: "object" };
    const complete: CodexChromeRecord = {
      ...codex,
      evidenceId: "evidence-2",
      artifactSha256: "c".repeat(64),
      toolNames: [...codex.identity.allowedTools],
      toolInventorySha256: "d".repeat(64),
      identity: {
        ...codex.identity,
        advertisedTools: codex.identity.allowedTools.map((name) => ({ name, inputSchema: schema })),
      },
    };
    expect(recordCertifies(complete)).toBe(true);
    // Names without the digest or the advertised definitions: every call would be denied.
    const { toolInventorySha256: _inventory, ...noDigest } = complete;
    expect(recordCertifies(noDigest)).toBe(false);
    expect(
      recordCertifies({
        ...complete,
        identity: { ...complete.identity, advertisedTools: [{ name: "js", inputSchema: schema }] },
      }),
    ).toBe(codex.identity.allowedTools.every((name) => name === "js"));
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
      artifactSha256: "b".repeat(64),
    };
    expect(evidenceMismatches(certified, report)).toEqual([]);
    const { artifactSha256: _artifact, ...unpackaged } = report;
    expect(evidenceMismatches(certified, unpackaged)).toEqual(["artifactSha256"]);
    // A report from a different build never supports the record.
    expect(evidenceMismatches(certified, { ...report, artifactSha256: "e".repeat(64) })).toEqual([
      "artifactSha256",
    ]);
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

  it("excludes every browser any record registers from native control", () => {
    const ids = integrationBrowserBundleIds();
    expect(ids).toContain("com.google.Chrome");
    for (const record of allRecords)
      for (const browser of record.browsers) expect(ids).toContain(browser.bundleId);
  });
});
