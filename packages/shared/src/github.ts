import { GITHUB_HOST_PATTERN } from "@t3tools/contracts";

/**
 * Normalizes user-entered GitHub hosts (`" https://GitHub.com/ "` → `"github.com"`).
 * Returns `null` when the value is not a bare hostname accepted by the WS contract.
 */
export function normalizeGithubHost(input: string): string | null {
  const host = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  if (!GITHUB_HOST_PATTERN.test(host) || host.includes("..")) return null;
  return host;
}
