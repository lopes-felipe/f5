import { compareCodexCliVersions, parseCodexCliVersion } from "@t3tools/shared/codexCliVersion";

export { compareCodexCliVersions, parseCodexCliVersion };

export const MINIMUM_CODEX_CLI_VERSION = "0.37.0";

export function isCodexCliVersionSupported(version: string): boolean {
  return compareCodexCliVersions(version, MINIMUM_CODEX_CLI_VERSION) >= 0;
}

export function formatCodexCliUpgradeMessage(version: string | null): string {
  const versionLabel = version ? `v${version}` : "the installed version";
  return `Codex CLI ${versionLabel} is too old for F5. Upgrade to v${MINIMUM_CODEX_CLI_VERSION} or newer and restart F5.`;
}
