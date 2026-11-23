import { compareVersions } from "@t3tools/shared/providerIntegrationCertification";

/**
 * The oldest Antigravity version whose private on-disk formats F5 reads: the OAuth token file the
 * subscription quota reader uses, the native session trajectory that explains failed turns, and
 * the child-work files behind the Agents panel. Older versions run standard ACP only.
 *
 * Newer versions are trusted without a per-release check because every reader fails closed: a
 * file, row or field it can't decode yields no quota, no failure detail or no child work, never
 * a wrong one. Checked releases: 1.5.13, and 1.5.15, which records subagent launches as generic
 * steps (handled in AntigravityChildWork). Raise the floor when a release drops a format.
 */
export const ANTIGRAVITY_PRIVATE_FORMAT_MIN_VERSION = "1.5.13";

export type AntigravityPrivateFormatGate =
  | { readonly enabled: true; readonly version: string }
  | { readonly enabled: false; readonly reason: string };

/** Whether the private-format readers may run against this runtime version. */
export function antigravityPrivateFormatGate(
  version: string | null | undefined,
): AntigravityPrivateFormatGate {
  const trimmed = version?.trim();
  if (!trimmed) {
    return {
      enabled: false,
      reason: "The Antigravity version is unknown, so F5 runs standard ACP only.",
    };
  }
  const comparison = compareVersions(trimmed, ANTIGRAVITY_PRIVATE_FORMAT_MIN_VERSION);
  if (comparison === undefined) {
    return {
      enabled: false,
      reason: `Antigravity ${trimmed} has an unrecognised version number, so quota, turn-failure details and native child work are unavailable.`,
    };
  }
  if (comparison >= 0) return { enabled: true, version: trimmed };
  return {
    enabled: false,
    reason: `Antigravity ${trimmed} is older than ${ANTIGRAVITY_PRIVATE_FORMAT_MIN_VERSION}, so quota, turn-failure details and native child work are unavailable. Update Antigravity in Settings.`,
  };
}
