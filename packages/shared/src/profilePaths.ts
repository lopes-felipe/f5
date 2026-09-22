import * as Path from "node:path";

export const PROFILE_PROVIDER_HOME_NAMES = { codex: "codex", claudeAgent: "claude" } as const;
export const profilesRootDir = (defaultStateDir: string) =>
  `${Path.resolve(defaultStateDir)}-profiles`;
export const profileRegistryPath = (defaultStateDir: string) =>
  Path.join(profilesRootDir(defaultStateDir), "profiles.json");
export const profileLocksDir = (defaultStateDir: string) =>
  Path.join(profilesRootDir(defaultStateDir), "locks");
export const profileTrashDir = (defaultStateDir: string) =>
  Path.join(profilesRootDir(defaultStateDir), ".trash");
export function profileStateDir(
  defaultStateDir: string,
  profile: { readonly id: string; readonly isDefault: boolean },
): string {
  if (!/^[0-9a-f]{32}$/.test(profile.id))
    throw new Error("Invalid profile id: expected 32 lowercase hexadecimal characters.");
  if (profile.isDefault) return Path.resolve(defaultStateDir);
  const root = profilesRootDir(defaultStateDir);
  const target = Path.resolve(root, profile.id);
  if (Path.dirname(target) !== root)
    throw new Error("Profile directory escapes the profiles root.");
  return target;
}
export const profileProviderHomesDir = (stateDir: string) => Path.join(stateDir, "provider-homes");
