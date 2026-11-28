import { compareVersions } from "@t3tools/shared/providerIntegrationCertification";

/**
 * The oldest Antigravity version whose native session trajectories and child-work files F5 reads.
 * Older versions run standard ACP only.
 *
 * Newer versions are read without a per-release check. Each reader acts only on evidence that
 * names itself: an error step whose text is a recognised API or quota error, or a launch step
 * whose tool call is `invoke_subagent` with native child ids.
 * Anything else yields nothing. The one judgement that rests on step numbering alone (an error
 * step with unrecognised text) runs only on the releases in
 * `ANTIGRAVITY_VERIFIED_STEP_LAYOUT_VERSIONS`. Raise the floor when a release drops a format.
 */
export const ANTIGRAVITY_PRIVATE_FORMAT_MIN_VERSION = "1.5.13";

/**
 * Releases whose step-type numbering was read from the binary's own enum: 1.5.13, and 1.5.15,
 * which also records subagent launches as generic steps (handled in AntigravityChildWork).
 */
export const ANTIGRAVITY_VERIFIED_STEP_LAYOUT_VERSIONS: ReadonlySet<string> = new Set([
  "1.5.13",
  "1.5.15",
]);

/** Whether an error step with unrecognised text may fail a turn on this runtime. */
export const antigravityStepLayoutVerified = (version: string | null | undefined) =>
  version !== null &&
  version !== undefined &&
  ANTIGRAVITY_VERIFIED_STEP_LAYOUT_VERSIONS.has(version.trim());

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
      reason: `Antigravity ${trimmed} has an unrecognised version number, so turn-failure details and native child work are unavailable.`,
    };
  }
  if (comparison >= 0) return { enabled: true, version: trimmed };
  return {
    enabled: false,
    reason: `Antigravity ${trimmed} is older than ${ANTIGRAVITY_PRIVATE_FORMAT_MIN_VERSION}, so turn-failure details and native child work are unavailable. Update Antigravity in Settings.`,
  };
}
