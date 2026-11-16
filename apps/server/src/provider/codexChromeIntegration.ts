import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { McpServerDefinition, RuntimeMode } from "@t3tools/contracts";
import { CodeSignatureCache } from "@t3tools/shared/codeSignature";
import {
  CODEX_CHROME_DRAIN_TOOL,
  PROVIDER_INTEGRATION_RECORDS,
  certifiedIntegrationRecord,
  codexParentIdentifierAllowed,
  compareVersions,
  integrationUnavailableDetail,
  recordCertifies,
} from "@t3tools/shared/providerIntegrationCertification";
import { probeCodexCliVersion } from "../codex/cliVersionProbe";
import { resolveExecutable } from "../spawn/resolveCommand";
import { resolveCodexInstanceHomePaths } from "./Drivers/CodexHomeLayout";
import {
  CODEX_CHROME_NEEDS_FULL_ACCESS,
  CODEX_CHROME_NEEDS_ISOLATED_HOME,
  codexChromeChildEnvironment,
  codexVersionNote,
  inspectCodexChrome,
  type CodexChromeInstallation,
} from "../computer/codexNativeIntegrations";
import { INTEGRATION_TOOL_TIMEOUT_SEC } from "../mcp/IntegrationProxyCatalog";

export const CODEX_CHROME_SERVER_NAME = "node_repl";

export type CodexChromeEligibility =
  | {
      readonly eligible: true;
      readonly installation: CodexChromeInstallation;
      readonly codexHome: string;
    }
  | { readonly eligible: false; readonly reason: string; readonly recordId?: string };

/**
 * The CODEX_HOME the Codex process actually uses: the instance's `homePath`, else the
 * inherited `CODEX_HOME` (isolated profiles set one), else `~/.codex`.
 */
export function effectiveCodexHome(
  homePath: string | undefined,
  environment: NodeJS.ProcessEnv,
): string {
  return resolveCodexInstanceHomePaths({
    config: { homePath: homePath ?? "", shadowHomePath: "" },
    managed: false,
    inheritedCodexHome: environment.CODEX_HOME,
  })[0]!;
}

export const CODEX_CHROME_UNSIGNED_CODEX = "F5's Codex isn't an OpenAI-signed build.";

/** The `codex` F5 launches: its real path (signature) and version, when readable. */
export interface CodexBinaryFacts {
  readonly path?: string;
  readonly version?: string;
}

/**
 * Resolves the Codex binary a session would launch and, unless `probeVersion` is false
 * (the read-only settings preflight never spawns), asks it for its version. Never throws.
 */
export async function inspectCodexBinary(input: {
  readonly binaryPath: string;
  readonly processEnvironment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly homePath?: string;
  readonly probeVersion?: boolean;
}): Promise<CodexBinaryFacts> {
  const resolved = resolveExecutable(input.binaryPath, input.processEnvironment, {
    cwd: input.cwd,
  });
  const [path, version] = await Promise.all([
    resolved ? realpath(resolved).catch(() => undefined) : Promise.resolve(undefined),
    input.probeVersion === false
      ? Promise.resolve(null)
      : probeCodexCliVersion({
          processEnvironment: input.processEnvironment,
          binaryPath: input.binaryPath,
          cwd: input.cwd,
          ...(input.homePath ? { homePath: input.homePath } : {}),
        }).catch(() => null),
  ]);
  return { ...(path ? { path } : {}), ...(version ? { version } : {}) };
}

const codexSignatures = new CodeSignatureCache();
/** ChatGPT's Chrome host serves `node_repl` only under a Codex signed like this. */
export async function codexBinarySigned(path: string, teamId: string): Promise<boolean> {
  const signature = await codexSignatures.probe(path, { teamId });
  return signature.ok && codexParentIdentifierAllowed(signature.identifier);
}

/**
 * Read-only eligibility for one Codex instance: a certified record, an isolated
 * CODEX_HOME (never the user's global `~/.codex`), an OpenAI-signed Codex at or above the
 * record's floor, and a verified ChatGPT installation. Session start passes its runtime
 * mode and requires Full access; only the settings preflight passes `"preflight"`, and
 * reports that requirement in its text instead.
 */
export async function codexChromeEligibility(input: {
  readonly codexHome: string | undefined;
  readonly userHome: string;
  readonly runtimeMode: RuntimeMode | "preflight";
  readonly codex: CodexBinaryFacts;
  readonly platform?: string;
  readonly arch?: string;
  readonly inspect?: typeof inspectCodexChrome;
  readonly codexSigned?: (path: string, teamId: string) => Promise<boolean>;
}): Promise<CodexChromeEligibility> {
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  // Any certifying record opens the gate; the installed ChatGPT version then picks the
  // one with the highest floor at or below it, so a newer floor never shadows an older.
  const certifying = PROVIDER_INTEGRATION_RECORDS["codex-chrome"].filter(
    (entry) => entry.platform === platform && entry.arch === arch && recordCertifies(entry),
  );
  const record = certifiedIntegrationRecord("codex-chrome", platform, arch, certifying);
  if (!record)
    return {
      eligible: false,
      reason:
        integrationUnavailableDetail("codex-chrome", platform, arch) ??
        "Codex Chrome control is unavailable.",
    };
  if (input.runtimeMode !== "preflight" && input.runtimeMode !== "full-access")
    return { eligible: false, reason: CODEX_CHROME_NEEDS_FULL_ACCESS, recordId: record.id };
  if (!input.codexHome)
    return { eligible: false, reason: CODEX_CHROME_NEEDS_ISOLATED_HOME, recordId: record.id };
  const [home, global] = await Promise.all([
    realpath(input.codexHome).catch(() => input.codexHome!),
    realpath(join(input.userHome, ".codex")).catch(() => join(input.userHome, ".codex")),
  ]);
  if (home === global)
    return { eligible: false, reason: CODEX_CHROME_NEEDS_ISOLATED_HOME, recordId: record.id };
  const floor = record.versions.codexMin;
  // The preflight doesn't run Codex, so only session start knows its version.
  const versionKnown = input.codex.version !== undefined || input.runtimeMode !== "preflight";
  if (
    versionKnown &&
    (!input.codex.version || (compareVersions(input.codex.version, floor) ?? -1) < 0)
  )
    return {
      eligible: false,
      reason: `Codex Chrome control needs Codex ${floor ?? "(certified)"} or newer${
        input.codex.version ? `; F5 runs ${input.codex.version}` : ""
      }.`,
      recordId: record.id,
    };
  if (
    !input.codex.path ||
    !(await (input.codexSigned ?? codexBinarySigned)(input.codex.path, record.identity.teamId))
  )
    return { eligible: false, reason: CODEX_CHROME_UNSIGNED_CODEX, recordId: record.id };
  const installation = await (input.inspect ?? inspectCodexChrome)({
    platform,
    arch,
    userHome: input.userHome,
    records: certifying,
  });
  if (!installation.available)
    return { eligible: false, reason: installation.reason, recordId: record.id };
  return { eligible: true, installation, codexHome: home };
}

/** Settings copy for a ready preflight; a newer-than-certified ChatGPT is noted, never blocked. */
export function codexChromeReadyDetail(installation: CodexChromeInstallation): string {
  const note = codexVersionNote(installation.record.versions.appMin, installation.appVersion);
  const floor = installation.record.versions.codexMin;
  const needs = `Sessions also need Full access${floor ? ` and Codex ${floor} or newer` : ""}.`;
  return note ? `${needs} ${note}` : needs;
}

/**
 * Codex's own MCP entry for ChatGPT's `node_repl`: Codex starts it, because ChatGPT's
 * Chrome host serves only a runtime whose parent is a signed Codex. Only the allowed tools
 * and the drain hook are enabled, and calls are bounded like the old proxy's. No approval
 * mode is set: Codex asks none in Full access, so F5 controls the session, not each call.
 */
export function codexChromeMcpServer(
  eligibility: Extract<CodexChromeEligibility, { eligible: true }>,
  processEnvironment: NodeJS.ProcessEnv = process.env,
): McpServerDefinition {
  const { installation, codexHome } = eligibility;
  return {
    type: "stdio",
    command: installation.nodeRepl,
    args: [],
    env: Object.fromEntries(
      Object.entries(
        codexChromeChildEnvironment(installation, codexHome, processEnvironment),
      ).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
    enabledTools: [...installation.record.identity.allowedTools, CODEX_CHROME_DRAIN_TOOL],
    toolTimeoutSec: INTEGRATION_TOOL_TIMEOUT_SEC,
  };
}

/**
 * Restart fingerprint: the catalog is pinned at launch, so turning the toggle on or off
 * restarts the session before the next turn. Health changes are reported live instead.
 */
export function codexChromeFingerprint(enabled: boolean): string {
  return JSON.stringify({ codexChrome: enabled });
}
