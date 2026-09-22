import * as FS from "node:fs";
import * as Path from "node:path";
import { fallbackDefaultProfile } from "@t3tools/shared/profileIdentity";
import { Schema } from "effect";
import { ProfileRegistryFile, type ProfileRecord } from "@t3tools/contracts";
import { profileRegistryPath, profileStateDir } from "@t3tools/shared/profilePaths";

/** Electron only reads. The backend is the sole registry writer. */
export function readDesktopProfiles(defaultStateDir: string): readonly ProfileRecord[] {
  const registryPath = profileRegistryPath(defaultStateDir);
  for (const candidate of [Path.dirname(registryPath), registryPath])
    if (FS.lstatSync(candidate).isSymbolicLink())
      throw new Error(`Profiles registry is a symbolic link: ${candidate}`);
  const raw: unknown = JSON.parse(FS.readFileSync(registryPath, "utf8"));
  if (typeof raw !== "object" || raw === null || !("version" in raw) || raw.version !== 1)
    throw new Error("Unsupported profiles registry version.");
  const registry = Schema.decodeUnknownSync(ProfileRegistryFile)(raw);
  if (
    registry.profiles.filter((p) => p.isDefault).length !== 1 ||
    registry.profiles.some((p) => p.isDefault !== (p.slug === "default"))
  )
    throw new Error("Invalid default profile registry entry.");
  for (const field of ["id", "slug", "port"] as const)
    if (new Set(registry.profiles.map((p) => p[field])).size !== registry.profiles.length)
      throw new Error(`Duplicate profile ${field}.`);
  for (const record of registry.profiles) {
    const directory = profileStateDir(defaultStateDir, record);
    if (FS.existsSync(directory) && FS.lstatSync(directory).isSymbolicLink())
      throw new Error(`Profile directory is a symbolic link: ${directory}`);
  }
  return registry.profiles;
}
export function desktopDefaultProfile(defaultStateDir: string): ProfileRecord {
  try {
    return readDesktopProfiles(defaultStateDir).find((p) => p.isDefault)!;
  } catch {
    return fallbackDefaultProfile(defaultStateDir);
  }
}
