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
  /**
   * Exact versions for bundled providers (Claude). Codex records hold certified floors
   * (`*Min`); a missing `*Max` means no ceiling, and live checks guard newer builds.
   */
  readonly versions: Readonly<Record<string, string>>;
  readonly identity: Identity;
  readonly browsers: ReadonlyArray<IntegrationBrowser>;
  readonly toolNames?: ReadonlyArray<string>;
  readonly toolInventorySha256?: string;
  readonly profileIsolation: "isolated" | "shared-disclosed";
  /** Names `docs/computer-certification/<evidenceId>.json`. Absent: not certified. */
  readonly evidenceId?: string;
  /**
   * The clean F5 commit the live run exercised, copied from its report. Stamping changes
   * the bundle, so the shipped build is bound separately: a release is promoted only with
   * an acceptance report for its exact artifact (`scripts/promote-release.ts`).
   */
  readonly evidenceCommit?: string;
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
const COMMIT = /^[a-f0-9]{40}$/;

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
    COMMIT.test(record.evidenceCommit ?? "") &&
    runtimeComplete(record)
  );
}

const parseVersion = (value: string | undefined) => {
  if (value === undefined) return undefined;
  const parts = value.split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));
  return parts.some(Number.isNaN) ? undefined : parts;
};

/** Compares dotted numeric versions; undefined when either has a non-numeric part. */
export function compareVersions(a: string | undefined, b: string | undefined): number | undefined {
  const [left, right] = [parseVersion(a), parseVersion(b)];
  if (!left || !right) return undefined;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta) return delta;
  }
  return 0;
}

/** The version a record certifies from: a Codex floor (`appMin`) or Claude's exact CLI. */
const certifiedFrom = (record: ProviderIntegrationRecord) =>
  record.versions.appMin ?? record.versions.cliVersion;

/** Newest certified version first; records without a readable version last. */
export function newestRecordsFirst<R extends ProviderIntegrationRecord>(
  records: ReadonlyArray<R>,
): R[] {
  return [...records].sort(
    (a, b) =>
      compareVersions(certifiedFrom(b), certifiedFrom(a)) ??
      (parseVersion(certifiedFrom(a)) ? -1 : parseVersion(certifiedFrom(b)) ? 1 : 0),
  );
}

/**
 * The record for an installed provider `version`: the highest floor at or below it, so a
 * newer floor takes over for builds it covers without shadowing builds still below it.
 */
export function recordForVersion<R extends ProviderIntegrationRecord>(
  records: ReadonlyArray<R>,
  version: string,
): R | undefined {
  return newestRecordsFirst(records).find(
    (record) => (compareVersions(certifiedFrom(record), version) ?? 1) <= 0,
  );
}

/**
 * The static identity a new certification run exercises and stamps: the newest
 * non-withdrawn record for the target. Shared by the live harness and the stamper.
 */
export function integrationTemplateRecord<R extends ProviderIntegrationRecord>(
  records: ReadonlyArray<R>,
  platform: string,
  arch: string,
): R | undefined {
  return newestRecordsFirst(
    records.filter(
      (record) => record.platform === platform && record.arch === arch && !record.withdrawn,
    ),
  )[0];
}

/**
 * The only certification gate. Desktop and server both read it, so they cannot disagree.
 * With the installed provider `version`, the record that covers it; otherwise the newest.
 */
export function certifiedIntegrationRecord<I extends ProviderIntegration>(
  integration: I,
  platform: string,
  arch: string,
  records: ReadonlyArray<RecordFor<I>> = PROVIDER_INTEGRATION_RECORDS[integration],
  version?: string,
): RecordFor<I> | undefined {
  const certifying = records.filter(
    (record) => record.platform === platform && record.arch === arch && recordCertifies(record),
  );
  return version === undefined
    ? newestRecordsFirst(certifying)[0]
    : recordForVersion(certifying, version);
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
    "background-work-stops-on-pause",
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
  /** Every listed tool with its schema, as observed; the allow-listed ones become `advertisedTools`. */
  readonly toolSchemas?: ReadonlyArray<{
    readonly name: string;
    readonly description?: string;
    readonly inputSchema: unknown;
  }>;
  /** `git rev-parse HEAD` of the F5 checkout that ran the harness. */
  readonly sourceCommit?: string;
  /** Whether that checkout had uncommitted changes; dirty runs certify nothing. */
  readonly dirty?: boolean;
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
  // A floor record cites the versions the run exercised as its `*Min`, with no ceiling.
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
  // What F5 shows before consent must be exactly what the run observed, descriptions too.
  if (record.integration === "codex-chrome" && record.identity.advertisedTools) {
    const observed = (name: string) => {
      const tool = report.toolSchemas?.find((entry) => entry.name === name);
      return tool && JSON.stringify([tool.name, tool.description ?? null, tool.inputSchema]);
    };
    const advertised = record.identity.advertisedTools;
    if (
      advertised.length !== record.identity.allowedTools.length ||
      advertised.some(
        (tool) =>
          observed(tool.name) !==
          JSON.stringify([tool.name, tool.description ?? null, tool.inputSchema]),
      )
    )
      problems.push("advertisedTools");
  }
  // Evidence comes from a clean, committed checkout, and the record names that commit.
  // The shipped artifact is bound later by the release's acceptance report.
  if (!COMMIT.test(report.sourceCommit ?? "") || report.sourceCommit !== record.evidenceCommit)
    problems.push("sourceCommit");
  if (report.dirty !== false) problems.push("dirty");
  return problems;
}

/**
 * Operator checks run in the installed release draft before it may be promoted. "auto"
 * checks are observed by `integrations:accept`; the rest are confirmed by the operator.
 */
export const INTEGRATION_ACCEPTANCE_CHECKS: Readonly<
  Record<
    ProviderIntegration,
    ReadonlyArray<{ readonly id: string; readonly label: string; readonly auto?: true }>
  >
> = Object.freeze({
  "claude-chrome": [
    { id: "manifests-created", label: "Setup consent creates the seven manifests", auto: true },
    { id: "read-only-call", label: "A read-only Claude in Chrome call works" },
    {
      id: "terminal-conflict",
      label: "A terminal `claude --chrome` makes F5 report external-cli-conflict",
    },
    { id: "emergency-stop", label: "⌃⌘Esc kills the Claude CLI process group", auto: true },
    {
      id: "restore-original-bytes",
      label: "Restore returns the original manifest bytes",
      auto: true,
    },
    { id: "isolated-profile-reason", label: "An isolated profile shows its unavailable reason" },
  ],
  "codex-chrome": [
    {
      id: "toggle-readiness",
      label: "The toggle is ready in Full access and shows the specific reason otherwise",
    },
    { id: "consent-once", label: "Consent is asked once per session" },
    { id: "open-tab-read-title", label: "Codex opens a tab and reads its title" },
    { id: "pause-stops", label: "Pause stops background work Codex started in Chrome", auto: true },
    { id: "emergency-stop", label: "⌃⌘Esc stops the node_repl process group", auto: true },
    { id: "idle-stop", label: "The child is gone after 60 s idle", auto: true },
    {
      id: "registrations-unchanged",
      label: "Registrations are byte-identical before and after",
      auto: true,
    },
  ],
  "codex-computer": [
    { id: "launch", label: "Computer Use launches from F5" },
    {
      id: "consent-disclosure",
      label: "Consent discloses shared approvals and unmaskable content",
    },
    { id: "target-enforced", label: "Calls act only on the granted app" },
    { id: "f5-windows-excluded", label: "F5 windows are excluded from captures" },
    { id: "emergency-stop", label: "⌃⌘Esc stops the current call", auto: true },
  ],
});

/** Operator acceptance of one release draft's exact artifact for one integration. */
export interface IntegrationAcceptanceReport {
  readonly kind: "acceptance";
  readonly integration: ProviderIntegration;
  readonly tag: string;
  readonly platform: string;
  readonly arch: string;
  readonly artifactName: string;
  readonly artifactSha256: string;
  /** The certifying records embedded in that build. */
  readonly recordIds: ReadonlyArray<string>;
  /** Commit the tag points at. */
  readonly sourceCommit: string;
  readonly checks: Readonly<Record<string, boolean>>;
}

/** Empty when the acceptance report covers the records and the artifact; otherwise each problem. */
export function acceptanceMismatches(
  report: IntegrationAcceptanceReport,
  expected: {
    readonly integration: ProviderIntegration;
    readonly tag: string;
    readonly artifactSha256: string;
    readonly recordIds: ReadonlyArray<string>;
  },
): string[] {
  const problems: string[] = [];
  if (report.kind !== "acceptance") problems.push("kind");
  if (report.integration !== expected.integration) problems.push("integration");
  if (report.tag !== expected.tag) problems.push("tag");
  if (
    !SHA256.test(report.artifactSha256 ?? "") ||
    report.artifactSha256 !== expected.artifactSha256
  )
    problems.push("artifactSha256");
  if (
    JSON.stringify([...(report.recordIds ?? [])].sort()) !==
    JSON.stringify([...expected.recordIds].sort())
  )
    problems.push("recordIds");
  for (const check of INTEGRATION_ACCEPTANCE_CHECKS[expected.integration])
    if (report.checks?.[check.id] !== true) problems.push(`check ${check.id}`);
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
