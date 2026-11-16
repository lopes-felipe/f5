import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { DesktopUpdateRecentInstall } from "@t3tools/contracts";

/** Records the update being installed so the relaunched app can confirm it. */
export function writeUpdateInstallMarker(path: string, marker: DesktopUpdateRecentInstall): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(marker));
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

/**
 * Reads and deletes the marker. Returns it only when the running version is the
 * one that was being installed; a failed install leaves the old version running.
 */
export function consumeUpdateInstallMarker(
  path: string,
  currentVersion: string,
): DesktopUpdateRecentInstall | null {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    value = null;
  }
  try {
    rmSync(path, { force: true });
  } catch (error) {
    console.warn("[desktop-updater] Could not remove the update install marker", error);
  }
  if (typeof value !== "object" || value === null) return null;
  const { fromVersion, toVersion, releaseNotes } = value as Record<string, unknown>;
  if (typeof fromVersion !== "string" || typeof toVersion !== "string") return null;
  if (toVersion !== currentVersion || fromVersion === toVersion) return null;
  return {
    fromVersion,
    toVersion,
    releaseNotes: typeof releaseNotes === "string" ? releaseNotes : null,
  };
}
