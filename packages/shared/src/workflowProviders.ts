import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderKind,
  type ServerProvider,
} from "@t3tools/contracts";

/**
 * Antigravity runtimes whose read-only workflow confinement passed the live certification in
 * `docs/providers/antigravity.md` (it sits beside the native-readers version floor in
 * `apps/server/src/provider/antigravityPrivateFormats.ts`). A run is certified for one exact
 * version on one platform. Add an entry only with the evidence from that procedure: a turn that
 * executes a write without asking can never be certified.
 */
export const ANTIGRAVITY_READ_ONLY_WORKFLOW_CERTIFIED_RUNTIMES: ReadonlyArray<{
  readonly version: string;
  readonly platform: string;
}> = [];

/** Providers that can never be confined to read-only workflow turns. */
const READ_ONLY_WORKFLOW_UNSUPPORTED_DRIVERS: ReadonlySet<string> = new Set(["grok", "muse"]);

export const READ_ONLY_WORKFLOW_UNCERTIFIED_ANTIGRAVITY_MESSAGE =
  "Read-only workflow turns are not certified for this Antigravity version.";

export function antigravityReadOnlyWorkflowCertified(
  version: string | null | undefined,
  platform: string | undefined,
): boolean {
  const trimmed = version?.trim();
  if (!trimmed || !platform) return false;
  return ANTIGRAVITY_READ_ONLY_WORKFLOW_CERTIFIED_RUNTIMES.some(
    (entry) => entry.version === trimmed && entry.platform === platform,
  );
}

/** Runtime-capability fact for one driver at one installed version. */
export function driverSupportsReadOnlyWorkflowTurns(
  driver: string,
  version: string | null | undefined,
  platform: string | undefined,
): boolean {
  if (READ_ONLY_WORKFLOW_UNSUPPORTED_DRIVERS.has(driver)) return false;
  if (driver === "antigravity") return antigravityReadOnlyWorkflowCertified(version, platform);
  return true;
}

/** Provider snapshot fields the workflow checks read. */
export type WorkflowProviderSnapshot = Pick<
  ServerProvider,
  "instanceId" | "driver" | "runtimeCapabilities"
>;

/** The snapshot workflow slots resolve against: the driver's default instance, else any. */
export function workflowProviderSnapshot<P extends Pick<ServerProvider, "instanceId" | "driver">>(
  provider: ProviderKind,
  providers: ReadonlyArray<P>,
): P | undefined {
  const driver = ProviderDriverKind.make(provider);
  const defaultInstanceId = defaultInstanceIdForDriver(driver);
  return (
    providers.find((candidate) => candidate.instanceId === defaultInstanceId) ??
    providers.find((candidate) => candidate.driver === driver)
  );
}

/**
 * Whether a provider may run read-only workflow turns (reviews, investigations, documents).
 * Grok and Muse never can. Antigravity can only when its default instance reports the
 * certified capability. Every other provider can.
 */
export function providerSupportsReadOnlyWorkflow(
  provider: ProviderKind,
  providers: ReadonlyArray<WorkflowProviderSnapshot>,
): boolean {
  if (READ_ONLY_WORKFLOW_UNSUPPORTED_DRIVERS.has(provider)) return false;
  if (provider !== "antigravity") return true;
  return (
    workflowProviderSnapshot(provider, providers)?.runtimeCapabilities?.readOnlyWorkflowTurns ===
    true
  );
}

/** User-facing reason a provider cannot run read-only workflow turns, or null when it can. */
export function readOnlyWorkflowUnsupportedReason(
  provider: ProviderKind,
  providers: ReadonlyArray<WorkflowProviderSnapshot>,
): string | null {
  if (providerSupportsReadOnlyWorkflow(provider, providers)) return null;
  return provider === "antigravity"
    ? READ_ONLY_WORKFLOW_UNCERTIFIED_ANTIGRAVITY_MESSAGE
    : "This provider cannot enforce read-only workflow turns.";
}
