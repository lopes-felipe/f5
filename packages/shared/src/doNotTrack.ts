/**
 * `DO_NOT_TRACK` is the common cross-tool opt-out (https://consoledonottrack.com).
 * F5 has no telemetry; when it is set, F5 also skips the background lookups it would
 * otherwise make on its own: the remote model manifest, automatic provider update
 * checks and remote file icons. Actions the user starts still run.
 */
const TRUTHY = new Set(["1", "true", "yes", "on", "y"]);

export function isDoNotTrackSet(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env.DO_NOT_TRACK;
  return value !== undefined && TRUTHY.has(value.trim().toLowerCase());
}
