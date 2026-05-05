import {
  defaultInstanceIdForDriver,
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  type ProviderKind,
  type ServerProvider,
} from "@t3tools/contracts";

export function createTestServerProvider(
  provider: ProviderKind,
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  const driver = ProviderDriverKind.make(provider);
  return {
    instanceId: defaultInstanceIdForDriver(driver),
    driver,
    displayName: PROVIDER_DISPLAY_NAMES[provider],
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}
