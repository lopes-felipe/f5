import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderKind,
  type ServerProvider,
} from "@t3tools/contracts";

import {
  ANTIGRAVITY_READ_ONLY_WORKFLOW_CERTIFIED_RUNTIMES,
  antigravityReadOnlySandboxCertified,
  READ_ONLY_UNSUPPORTED_DRIVERS,
  resolveReadOnlyEnforcement,
} from "./readOnlyEnforcement";

/**
 * Antigravity certification rows live in `readOnlyEnforcement.ts` beside the other providers'.
 * Each row is a floor: the certified release and every later one on that build target.
 */
export { ANTIGRAVITY_READ_ONLY_WORKFLOW_CERTIFIED_RUNTIMES };

/** This process's build target, `<platform>-<arch>` (such as `linux-x64`), when known. */
export function runtimeBuildTarget(): string | undefined {
  const runtime = globalThis.process;
  return runtime?.platform && runtime.arch ? `${runtime.platform}-${runtime.arch}` : undefined;
}

export const READ_ONLY_WORKFLOW_UNCERTIFIED_ANTIGRAVITY_MESSAGE =
  "Read-only workflow turns are not certified for this Antigravity version.";

/**
 * Whether this Antigravity release is at or above a certified floor for `target` (and, on
 * Windows, the host build can run Antigravity's sandbox).
 */
export function antigravityReadOnlyWorkflowCertified(
  version: string | null | undefined,
  target: string | undefined,
  osRelease?: string,
): boolean {
  return antigravityReadOnlySandboxCertified(version, { target, osRelease });
}

/**
 * Runtime-capability fact for one driver at one installed version on one build target
 * (`runtimeBuildTarget`). `osRelease` is the host's `os.release()`, required to trust a Windows
 * certification.
 */
export function driverSupportsReadOnlyWorkflowTurns(
  driver: string,
  version: string | null | undefined,
  target: string | undefined,
  osRelease?: string,
): boolean {
  return resolveReadOnlyEnforcement(driver, version, { target, osRelease }) !== undefined;
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
  if (READ_ONLY_UNSUPPORTED_DRIVERS.has(provider)) return false;
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
