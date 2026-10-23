import claudeChromeRecords from "./certification/claude-chrome.generated.json" with { type: "json" };
import codexChromeRecords from "./certification/codex-chrome.generated.json" with { type: "json" };
import codexComputerRecords from "./certification/codex-computer.generated.json" with { type: "json" };

/**
 * The single certification source for provider-native browser and computer integrations.
 * Records are generated from the shipped artifacts (static descriptor) and stamped with
 * a live run's evidence outside F5. Runtime never reads `docs/`; a record without
 * `evidenceId` describes an artifact but certifies nothing.
 */
export type ProviderIntegration = "claude-chrome" | "codex-chrome" | "codex-computer";

export interface IntegrationBrowser {
  /** Provider-side browser key, in the provider's lookup order. */
  readonly id: string;
  readonly bundleId: string;
  /** macOS path segments below the user's home. */
  readonly nativeMessagingPath: ReadonlyArray<string>;
}

export interface ClaudeChromeIdentity {
  readonly teamId: string;
  readonly platformPackage: string;
  readonly hostName: string;
  readonly hostDescription: string;
  readonly allowedOrigins: ReadonlyArray<string>;
  /** Wrapper location relative to the provider's `CLAUDE_CONFIG_DIR`. */
  readonly wrapperPath: ReadonlyArray<string>;
  readonly wrapperHeader: ReadonlyArray<string>;
  readonly nativeHostArgs: ReadonlyArray<string>;
  readonly mcpServerName: string;
  readonly mcpArgs: ReadonlyArray<string>;
}

export interface CodexChromeIdentity {
  readonly teamId: string;
  readonly appIdentifier: string;
  readonly hostName: string;
  readonly allowedOrigins: ReadonlyArray<string>;
  readonly hostIdentifier: string;
  readonly mcpServerName: string;
  readonly allowedTools: ReadonlyArray<string>;
  /**
   * The allow-listed tools exactly as the live run listed them. F5 advertises these before
   * consent so listing never starts `node_repl`; stamped from evidence with the inventory.
   */
  readonly advertisedTools?: ReadonlyArray<{
    readonly name: string;
    readonly description?: string;
    readonly inputSchema: unknown;
  }>;
}

export interface CodexComputerIdentity {
  readonly teamId: string;
  readonly appIdentifier: string;
  readonly serviceIdentifier: string;
  readonly mcpServerName: string;
}

interface RecordBase<I extends ProviderIntegration, Identity> {
  readonly integration: I;
  /** Stable record identifier, kept in journals so restore can use retired records. */
  readonly id: string;
  readonly platform: "darwin" | "win32";
  readonly arch: string;
  readonly versions: Readonly<Record<string, string>>;
  readonly identity: Identity;
  readonly browsers: ReadonlyArray<IntegrationBrowser>;
  readonly toolNames?: ReadonlyArray<string>;
  readonly toolInventorySha256?: string;
  readonly profileIsolation: "isolated" | "shared-disclosed";
  /** Names `docs/computer-certification/<evidenceId>.json`. Absent: not certified. */
  readonly evidenceId?: string;
  /**
   * Digest of the packaged, signed candidate build the live run exercised, copied from
   * its report. Stamping changes the bundle, so this names the certified candidate, not
   * the release that embeds the record.
   */
  readonly artifactSha256?: string;
  /** Withdrawn records stay for restore but certify nothing; CHANGELOG explains why. */
  readonly withdrawn?: string;
}

export type ClaudeChromeRecord = RecordBase<"claude-chrome", ClaudeChromeIdentity>;
export type CodexChromeRecord = RecordBase<"codex-chrome", CodexChromeIdentity>;
export type CodexComputerRecord = RecordBase<"codex-computer", CodexComputerIdentity>;
export type ProviderIntegrationRecord =
  | ClaudeChromeRecord
  | CodexChromeRecord
  | CodexComputerRecord;
type RecordFor<I extends ProviderIntegration> = Extract<
  ProviderIntegrationRecord,
  { integration: I }
>;

function freezeRecords<R extends ProviderIntegrationRecord>(
  integration: R["integration"],
  raw: ReadonlyArray<unknown>,
): ReadonlyArray<R> {
  return Object.freeze(
    raw.map((entry) => {
      const record = entry as R;
      if (record.integration !== integration || typeof record.id !== "string")
        throw new Error(`Malformed ${integration} certification record.`);
      return Object.freeze(record);
    }),
  );
}

export const PROVIDER_INTEGRATION_RECORDS: {
  readonly [I in ProviderIntegration]: ReadonlyArray<RecordFor<I>>;
} = Object.freeze({
  "claude-chrome": freezeRecords<ClaudeChromeRecord>("claude-chrome", claudeChromeRecords),
  "codex-chrome": freezeRecords<CodexChromeRecord>("codex-chrome", codexChromeRecords),
  "codex-computer": freezeRecords<CodexComputerRecord>("codex-computer", codexComputerRecords),
});

const SHA256 = /^[a-f0-9]{64}$/;

/** What each integration's runtime needs from a record to actually work once certified. */
function runtimeComplete(record: ProviderIntegrationRecord): boolean {
  switch (record.integration) {
    case "claude-chrome":
      // Admission checks the live server's tools against the stamped names.
      return (record.toolNames?.length ?? 0) > 0;
    case "codex-chrome": {
      // The proxy verifies the live inventory against the digest and lists the advertised
      // tools before consent; without both, every call would be denied.
      const advertised = new Set(record.identity.advertisedTools?.map((tool) => tool.name));
      return (
        SHA256.test(record.toolInventorySha256 ?? "") &&
        record.identity.allowedTools.length > 0 &&
        record.identity.allowedTools.every((name) => advertised.has(name))
      );
    }
    case "codex-computer":
      return SHA256.test(record.toolInventorySha256 ?? "");
  }
}

export function recordCertifies(record: ProviderIntegrationRecord): boolean {
  return (
    !record.withdrawn &&
    typeof record.evidenceId === "string" &&
    record.evidenceId.length > 0 &&
    SHA256.test(record.artifactSha256 ?? "") &&
    runtimeComplete(record)
  );
}

/** The only certification gate. Desktop and server both read it, so they cannot disagree. */
export function certifiedIntegrationRecord<I extends ProviderIntegration>(
  integration: I,
  platform: string,
  arch: string,
  records: ReadonlyArray<RecordFor<I>> = PROVIDER_INTEGRATION_RECORDS[integration],
): RecordFor<I> | undefined {
  return records.find(
    (record) => record.platform === platform && record.arch === arch && recordCertifies(record),
  );
}

export function isIntegrationCertified(
  integration: ProviderIntegration,
  platform: string,
  arch: string,
): boolean {
  return certifiedIntegrationRecord(integration, platform, arch) !== undefined;
}

/** Looks a record up by id, certified or not: restore keeps working after retirement. */
export function integrationRecordById(id: string): ProviderIntegrationRecord | undefined {
  for (const records of Object.values(PROVIDER_INTEGRATION_RECORDS))
    for (const record of records as ReadonlyArray<ProviderIntegrationRecord>)
      if (record.id === id) return record;
  return undefined;
}

const INTEGRATION_LABEL: Record<ProviderIntegration, string> = {
  "claude-chrome": "Claude in Chrome",
  "codex-chrome": "Codex Chrome control",
  "codex-computer": "Codex Computer Use",
};

/** Reason-specific copy for a closed gate; undefined when the integration is certified. */
export function integrationUnavailableDetail(
  integration: ProviderIntegration,
  platform: string,
  arch: string,
  records: ReadonlyArray<ProviderIntegrationRecord> = PROVIDER_INTEGRATION_RECORDS[integration],
): string | undefined {
  const label = INTEGRATION_LABEL[integration];
  const matching = records.filter((record) => record.integration === integration);
  if (
    matching.some(
      (record) => record.platform === platform && record.arch === arch && recordCertifies(record),
    )
  )
    return undefined;
  if (platform !== "darwin") return `${label} isn't supported on this operating system yet.`;
  const certifiedElsewhere = matching.some(
    (record) => record.platform === platform && recordCertifies(record),
  );
  if (certifiedElsewhere || !matching.some((record) => record.arch === arch))
    return `${label} is not certified on this Mac's architecture yet.`;
  if (matching.some((record) => record.arch === arch && record.withdrawn))
    return `${label} was withdrawn for this F5 build's provider version. Update F5.`;
  return `${label} is awaiting a live safety certification for this F5 build.`;
}

/**
 * Side effects disclosed in the consent dialog, the settings toggle and the docs. Kept
 * here so every surface shows the same, F5-authored text (never provider-supplied).
 */
export const INTEGRATION_DISCLOSURES: Readonly<Record<ProviderIntegration, ReadonlyArray<string>>> =
  Object.freeze({
    "claude-chrome": [
      "Claude creates native-messaging folders for seven browsers (Chrome, Brave, Arc, Edge, Chromium, Vivaldi and Opera) and points them at F5's Claude.",
      "Claude's first-time reconnect page can't open from F5; open the Claude in Chrome extension yourself.",
      "Running `claude --chrome` in a terminal reclaims the browser connection from F5.",
      "In Full access, Claude skips the extension's per-site permission prompts.",
    ],
    "codex-chrome": [
      "Codex uses the ChatGPT app's Chrome extension and helper; F5 never changes their setup.",
      "Its browser runtime runs unsandboxed JavaScript, so it needs Full access.",
      "Every call still goes through F5 and stops when you pause or press ⌃⌘Esc.",
    ],
    "codex-computer": [
      "Computer Use approvals are shared with the ChatGPT app on this Mac.",
      "F5 can't mask content that Computer Use observes without F5's grant.",
      "Every call still goes through F5 and stops when you pause or press ⌃⌘Esc.",
    ],
  });

/** Live-run assertions a scrubbed report must pass before a record may cite it. */
export const INTEGRATION_REQUIRED_ASSERTIONS: Readonly<
  Record<ProviderIntegration, ReadonlyArray<string>>
> = Object.freeze({
  "claude-chrome": [
    "manifests-and-wrapper",
    "allowed-origins",
    "write-ordering",
    "status-shape",
    "tool-inventory",
    "read-only-call",
    "permission-mode",
    "restore-original-bytes",
    "routing-isolation",
    "stale-native-host",
    "terminal-claude-unaffected",
    "frozen-server-stop-cancels-queued",
    "byte-identical-launches",
  ],
  "codex-chrome": [
    "open-tab-read-title",
    "registrations-unchanged",
    "interrupt-drains",
    "tool-inventory",
  ],
  "codex-computer": [
    "launch",
    "target-enforced",
    "ambiguous-target-refused",
    "f5-target-refused",
    "f5-windows-excluded",
    "cancel-stops",
    "tool-inventory",
  ],
});

/** Scrubbed live-run report: versions, assertions and inventory only. */
export interface IntegrationEvidenceReport {
  readonly integration: ProviderIntegration;
  readonly evidenceId: string;
  readonly platform: string;
  readonly arch: string;
  readonly versions: Readonly<Record<string, string>>;
  readonly assertions: Readonly<Record<string, boolean>>;
  readonly toolNames?: ReadonlyArray<string>;
  readonly toolInventorySha256?: string;
  /** Digest of the packaged, signed artifact the run exercised. */
  readonly artifactSha256?: string;
}

/** Empty when the report supports the record; otherwise each mismatch. */
export function evidenceMismatches(
  record: ProviderIntegrationRecord,
  report: IntegrationEvidenceReport,
): string[] {
  const problems: string[] = [];
  if (report.integration !== record.integration) problems.push("integration");
  if (report.evidenceId !== record.evidenceId) problems.push("evidenceId");
  if (report.platform !== record.platform || report.arch !== record.arch) problems.push("target");
  for (const [key, value] of Object.entries(record.versions))
    if (report.versions[key] !== value) problems.push(`versions.${key}`);
  for (const assertion of INTEGRATION_REQUIRED_ASSERTIONS[record.integration])
    if (report.assertions[assertion] !== true) problems.push(`assertion ${assertion}`);
  if (
    record.toolNames &&
    JSON.stringify([...record.toolNames].sort()) !==
      JSON.stringify([...(report.toolNames ?? [])].sort())
  )
    problems.push("toolNames");
  if (record.toolInventorySha256 && record.toolInventorySha256 !== report.toolInventorySha256)
    problems.push("toolInventorySha256");
  // Certification evidence comes from the packaged, signed candidate build, and the
  // record names that exact build.
  if (!SHA256.test(report.artifactSha256 ?? "") || report.artifactSha256 !== record.artifactSha256)
    problems.push("artifactSha256");
  return problems;
}

/** Bundle ids of every browser any record registers. Unions over all records so the
 * native-control exclusion never shrinks when a record is certified or retired. */
export function integrationBrowserBundleIds(): ReadonlyArray<string> {
  const ids = new Set<string>(["com.google.Chrome"]);
  for (const records of Object.values(PROVIDER_INTEGRATION_RECORDS))
    for (const record of records as ReadonlyArray<ProviderIntegrationRecord>)
      for (const browser of record.browsers) ids.add(browser.bundleId);
  return Object.freeze([...ids]);
}
