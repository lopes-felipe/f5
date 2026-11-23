/**
 * Antigravity versions whose private on-disk formats F5 has verified: the OAuth token file the
 * subscription quota reader refreshes from, the native session trajectory that explains failed
 * turns, and the child-work files behind the Agents panel. Other versions run standard ACP only.
 * Add a version here only after checking each reader against that release.
 */
export const ANTIGRAVITY_CERTIFIED_PRIVATE_FORMAT_VERSIONS: ReadonlySet<string> = new Set([
  "1.5.13",
  // Checked against a live 1.5.15 session: the token file, the `steps` table and transcript
  // lines are unchanged apart from added fields, and launches are recorded as generic steps.
  "1.5.15",
]);

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
  if (ANTIGRAVITY_CERTIFIED_PRIVATE_FORMAT_VERSIONS.has(trimmed)) {
    return { enabled: true, version: trimmed };
  }
  return {
    enabled: false,
    reason: `Antigravity ${trimmed} is not yet certified for F5's native readers, so quota, turn-failure details and native child work are unavailable.`,
  };
}
