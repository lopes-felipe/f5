import type { ProfileSummary, ServerProvider } from "@t3tools/contracts";

export function profileProviderAccounts(
  providers: readonly ServerProvider[],
): ProfileSummary["providerAccounts"] {
  return providers.map((provider) => ({
    driver: provider.driver,
    instanceId: provider.instanceId,
    displayName: provider.displayName ?? String(provider.instanceId),
    status: provider.unavailableReason?.includes("unsupported-isolation")
      ? "unsupported-isolation"
      : provider.auth.status,
    ...(provider.auth.email || provider.auth.label
      ? { identity: provider.auth.email ?? provider.auth.label! }
      : {}),
    ...(provider.unavailableReason ? { reason: provider.unavailableReason } : {}),
  }));
}
