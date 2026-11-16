export const DEFAULT_RELEASE_REPOSITORY = "lopes-felipe/f5";

const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/**
 * Validates the build-time `F5_RELEASE_REPOSITORY` value (`owner/name`).
 * Unset or blank uses the F5 repository; anything else malformed fails the
 * build instead of shipping download links to an unexpected location.
 */
export function resolveReleaseRepository(raw: string | undefined): string {
  const value = raw?.trim() ?? "";
  if (value.length === 0) return DEFAULT_RELEASE_REPOSITORY;
  if (!REPOSITORY_PATTERN.test(value) || value.endsWith("/.") || value.endsWith("/..")) {
    throw new Error(
      `F5_RELEASE_REPOSITORY must be a GitHub "owner/name" repository; received ${JSON.stringify(raw)}`,
    );
  }
  return value;
}
