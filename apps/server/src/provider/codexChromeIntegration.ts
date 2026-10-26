import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeMode } from "@t3tools/contracts";
import {
  PROVIDER_INTEGRATION_RECORDS,
  certifiedIntegrationRecord,
  integrationUnavailableDetail,
  recordCertifies,
} from "@t3tools/shared/providerIntegrationCertification";
import type { ComputerAutomationBrokerRuntime } from "../computer/ComputerAutomationBroker";
import { resolveCodexInstanceHomePaths } from "./Drivers/CodexHomeLayout";
import {
  CODEX_CHROME_NEEDS_FULL_ACCESS,
  CODEX_CHROME_NEEDS_ISOLATED_HOME,
  codexChromeChildEnvironment,
  codexChromeInstructions,
  codexChromeInstallationUnchanged,
  codexChromeRegistrationsUnchanged,
  codexVersionNote,
  inspectCodexChrome,
  type CodexChromeInstallation,
} from "../computer/codexNativeIntegrations";
import {
  IntegrationProxySession,
  type IntegrationProxyState,
} from "../mcp/IntegrationProxyCatalog";

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

/**
 * Read-only eligibility for one Codex instance: a certified record, an isolated
 * CODEX_HOME (never the user's global `~/.codex`) and a verified ChatGPT installation.
 * Session start passes its runtime mode and requires Full access; only the settings
 * preflight passes `"preflight"`, and reports that requirement in its text instead.
 */
export async function codexChromeEligibility(input: {
  readonly codexHome: string | undefined;
  readonly userHome: string;
  readonly runtimeMode: RuntimeMode | "preflight";
  readonly platform?: string;
  readonly arch?: string;
  readonly inspect?: typeof inspectCodexChrome;
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
  return note ? `Sessions also need Full access. ${note}` : "Sessions also need Full access.";
}

/**
 * One proxied `node_repl` per session generation. Session consent is asked on the
 * first call; every call still passes live policy, pause, generation, the registration
 * snapshot, the verified inventory and the Chrome lease held for the child's life.
 */
export function makeCodexChromeProxy(input: {
  readonly threadId: string;
  readonly generation: string;
  readonly eligibility: Extract<CodexChromeEligibility, { eligible: true }>;
  readonly userHome: string;
  readonly cwd?: string;
  readonly broker: ComputerAutomationBrokerRuntime;
  readonly policyEnabled: () => Promise<boolean>;
  readonly processEnvironment?: NodeJS.ProcessEnv;
  readonly stateChanged?: (state: IntegrationProxyState, detail?: string) => void;
  readonly inspect?: typeof inspectCodexChrome;
}): { readonly session: IntegrationProxySession; readonly instructions: string } {
  const { installation, codexHome } = input.eligibility;
  const { broker } = input;
  const holder = {
    profileId: broker.host.profileId,
    threadId: input.threadId,
    sessionGeneration: input.generation,
    provider: "codex" as const,
  };
  const session = new IntegrationProxySession({
    integration: "codex-chrome",
    threadId: input.threadId,
    generation: input.generation,
    command: installation.nodeRepl,
    args: [],
    env: codexChromeChildEnvironment(
      installation,
      codexHome,
      input.processEnvironment ?? process.env,
    ),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    allowedTools: installation.record.identity.allowedTools,
    toolInventorySha256: installation.record.toolInventorySha256,
    ...(installation.record.identity.advertisedTools
      ? { advertisedTools: installation.record.identity.advertisedTools }
      : {}),
    identity: {
      profileId: broker.host.profileId,
      backendIncarnation: broker.host.backendIncarnation,
      threadId: input.threadId,
      sessionGeneration: input.generation,
      integration: "codex-chrome",
    },
    register: (registration) => broker.registerIntegrationProcess(registration),
    exited: (launchToken) => broker.reportIntegrationExit(launchToken),
    policyEnabled: input.policyEnabled,
    currentGeneration: () => broker.generation(input.threadId),
    paused: () => broker.pause.has(input.threadId),
    consent: () => broker.requestChromeSession(input.threadId, input.generation, "codex-chrome"),
    check: async () => {
      if (broker.chromeRecoveryRequired())
        return "Browser control from an earlier session hasn't stopped yet.";
      return (await codexChromeRegistrationsUnchanged(installation, input.userHome))
        ? undefined
        : "The ChatGPT Chrome helper's setup changed. Start a new session to use Chrome.";
    },
    // The child may start hours after the session: signatures and versions are checked
    // again so an app update in between never runs under the session's verification.
    beforeSpawn: async () => {
      const current = await (input.inspect ?? inspectCodexChrome)({
        userHome: input.userHome,
        record: installation.record,
      });
      if (!current.available) return current.reason;
      return codexChromeInstallationUnchanged(installation, current)
        ? undefined
        : "The ChatGPT app changed since this session started. Start a new session to use Chrome.";
    },
    acquireLease: async () => {
      await broker.host.correlated(
        { type: "chromeLeaseAcquire", requestId: randomUUID(), holder },
        5000,
        false,
      );
    },
    releaseLease: () =>
      broker.host.send({ type: "chromeLeaseRelease", requestId: randomUUID(), holder }),
    ...(input.stateChanged ? { stateChanged: input.stateChanged } : {}),
    disposed: () => offPause(),
  });
  // Pause cancels in-flight calls and stops the child; the lease ends once its group exits.
  const offPause = broker.pause.subscribe((threadId, paused) => {
    if (paused && threadId === input.threadId) session.cancel();
  });
  return { session, instructions: codexChromeInstructions(installation) };
}

/**
 * Restart fingerprint: the catalog is pinned at launch, so turning the toggle on or off
 * restarts the session before the next turn. Health changes are reported live instead.
 */
export function codexChromeFingerprint(enabled: boolean): string {
  return JSON.stringify({ codexChrome: enabled });
}
