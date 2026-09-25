import { GITHUB_HOST_PATTERN } from "@t3tools/contracts";
import { accountLoginOutput } from "./cliLoginOutput";

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

export interface GhDeviceLoginPrompt {
  userCode: string;
  verificationUri: string;
  /** gh is waiting for Enter before it continues (interactive stdin only). */
  awaitsEnter: boolean;
}

/**
 * Parses `gh auth login --web` output. gh 2.x prints one of:
 * "! First copy your one-time code: XXXX-XXXX", "! One-time code (XXXX-XXXX) copied to clipboard",
 * followed by "Open this URL to continue in your web browser: https://<host>/login/device"
 * or "Press Enter to open https://<host>/login/device in your browser...".
 */
export function parseGhDeviceLogin(output: string, host: string): GhDeviceLoginPrompt | null {
  const { text, urls } = accountLoginOutput(output);
  const code = /one-time code(?::\s*|\s*\()([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(text)?.[1];
  const verificationUri = urls.find((url) => {
    try {
      const parsed = new URL(url);
      return parsed.hostname === host && parsed.pathname.replace(/\/+$/, "") === "/login/device";
    } catch {
      return false;
    }
  });
  if (!code || !verificationUri) return null;
  return {
    userCode: code.toUpperCase(),
    verificationUri,
    awaitsEnter: /press enter/i.test(text),
  };
}
