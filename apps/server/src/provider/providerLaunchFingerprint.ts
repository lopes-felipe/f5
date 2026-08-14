import { createHash } from "node:crypto";

import type {
  ProviderInstanceId,
  ProviderKind,
  ProviderStartOptions,
  RuntimeMode,
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
}): string {
  const identity = JSON.stringify({
    version: 1,
    provider: input.provider,
    providerInstanceId: input.providerInstanceId,
    runtimeMode: input.runtimeMode,
    cwd: input.cwd ?? "",
    environmentKey: getProviderEnvironmentKey(input.provider, input.providerOptions),
    instanceLaunchIdentity: input.instanceLaunchIdentity ?? "",
    mcpEffectiveConfigVersion: input.mcpEffectiveConfigVersion ?? "",
  });
  return createHash("sha256").update(identity).digest("hex");
}
