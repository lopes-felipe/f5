import { createHash } from "node:crypto";

import type {
  ProviderInstanceId,
  ProviderKind,
  ProviderStartOptions,
  RuntimeMode,
  WorkflowTurnExecutionProfile,
} from "@t3tools/contracts";
import { getProviderEnvironmentKey } from "@t3tools/shared/providerOptions";

export function computeProviderLaunchFingerprint(input: {
  readonly provider: ProviderKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly runtimeMode: RuntimeMode;
  readonly cwd?: string;
  readonly providerOptions?: ProviderStartOptions;
  readonly instanceLaunchIdentity?: string;
  readonly mcpEffectiveConfigVersion?: string | null;
  readonly workflowExecutionProfile?: WorkflowTurnExecutionProfile;
  /** Read-only stage capabilities; changes recreate the session so stale tools cannot survive. */
  readonly workflowCapabilityDigest?: string;
}): string {
  const identity = JSON.stringify({
    // v3: read-only stages carry host-computed capabilities.
    version: 3,
    provider: input.provider,
    providerInstanceId: input.providerInstanceId,
    runtimeMode: input.runtimeMode,
    cwd: input.cwd ?? "",
    environmentKey: getProviderEnvironmentKey(input.provider, input.providerOptions),
    instanceLaunchIdentity: input.instanceLaunchIdentity ?? "",
    mcpEffectiveConfigVersion: input.mcpEffectiveConfigVersion ?? "",
    workflowExecutionProfile: input.workflowExecutionProfile ?? "",
    workflowCapabilityDigest: input.workflowCapabilityDigest ?? "",
  });
  return createHash("sha256").update(identity).digest("hex");
}
