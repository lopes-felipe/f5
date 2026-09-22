import type { ProfileSummary } from "@t3tools/contracts";

import { ensureNativeApi } from "./nativeApi";
import { profileBrowserUrl, recordProfilePatch, refreshProfiles } from "./profileState";

/**
 * Imperative command layer for profile mutations.
 *
 * Every function throws on failure; callers decide whether that becomes a
 * toast or an inline error. Rules the server enforces opaquely (removing the
 * active profile fails on its own instance lock) are checked here so the user
 * gets a sentence instead of a lock-file message.
 */

function profilesApi() {
  const api = ensureNativeApi().profiles;
  if (!api) throw new Error("This server was started without a profiles directory.");
  return api;
}

export function canSwitchProfile(): boolean {
  return typeof window.desktopBridge?.switchProfile === "function";
}

export function canStopProfile(): boolean {
  return typeof window.desktopBridge?.stopProfile === "function";
}

export async function createProfile(input: {
  name: string;
  accentColor?: string;
}): Promise<ProfileSummary> {
  const created = await profilesApi().create({
    name: input.name,
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
  });
  await refreshProfiles();
  return created;
}

/**
 * Commit a field-level edit.
 *
 * The RPC response is deliberately used only for success/failure: the server
 * returns a degraded summary on `profiles.update` (`providerAccounts: []`, no
 * warnings), so merging it wholesale would wipe the active profile's account
 * list. The store is refreshed instead, guarded by the recorded patch so the
 * server's 2000ms read cache cannot replay the pre-edit value.
 */
export async function updateProfile(
  profile: ProfileSummary,
  patch: { name?: string; port?: number; accentColor?: string },
): Promise<void> {
  await profilesApi().update({
    profileId: profile.id,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.port !== undefined ? { port: patch.port } : {}),
    ...(patch.accentColor !== undefined ? { accentColor: patch.accentColor } : {}),
  });
  recordProfilePatch(profile.id, patch);
  await refreshProfiles();
}

export async function removeProfile(profile: ProfileSummary): Promise<void> {
  if (profile.isDefault) throw new Error("The default profile cannot be removed.");
  if (profile.isActive) throw new Error("Switch to another profile before removing this one.");
  // Releases the instance lock the registry acquires during removal.
  if (window.desktopBridge?.stopProfile) {
    await window.desktopBridge.stopProfile(profile.id);
  }
  await profilesApi().remove({ profileId: profile.id });
  await refreshProfiles();
}

export async function stopProfile(profile: ProfileSummary): Promise<void> {
  const stop = window.desktopBridge?.stopProfile;
  if (!stop) throw new Error("Stopping a profile requires the desktop app.");
  await stop(profile.id);
  await refreshProfiles();
}

export async function openProfile(profile: ProfileSummary): Promise<void> {
  const switchProfile = window.desktopBridge?.switchProfile;
  if (!switchProfile) {
    window.open(profileBrowserUrl(profile), "_blank", "noreferrer");
    return;
  }
  await switchProfile(profile.id);
}
