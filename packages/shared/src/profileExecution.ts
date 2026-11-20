import {
  PROFILE_REGISTRY_VERSION_HOST,
  PROFILE_REGISTRY_VERSION_LINUX_VM,
  type ProfileExecutionEnvironment,
  type ProfileRecord,
} from "@t3tools/contracts";

/** Where a profile runs. Records written before VM profiles have no field and mean `host`. */
export const profileExecutionEnvironment = (
  record: Pick<ProfileRecord, "executionEnvironment">,
): ProfileExecutionEnvironment => record.executionEnvironment ?? "host";

export const isLinuxVmProfile = (record: Pick<ProfileRecord, "executionEnvironment">) =>
  profileExecutionEnvironment(record) === "linux-vm";

/**
 * Why a host process refuses to serve or open `profile`, or `undefined` for host profiles.
 * Linux VM profiles run only in their guest; this build has no VM runtime to start one.
 */
export const hostExecutionRefusal = (
  profile: Pick<ProfileRecord, "executionEnvironment" | "slug">,
): string | undefined =>
  isLinuxVmProfile(profile)
    ? `Profile '${profile.slug}' runs in a Linux VM, which this version of F5 can't start. F5 never runs it on the host; open a host profile instead.`
    : undefined;

/** The version a registry holding `profiles` is written with: v2 only while a VM profile exists. */
export const profileRegistryVersionFor = (
  profiles: ReadonlyArray<Pick<ProfileRecord, "executionEnvironment">>,
): number =>
  profiles.some(isLinuxVmProfile) ? PROFILE_REGISTRY_VERSION_LINUX_VM : PROFILE_REGISTRY_VERSION_HOST;

/**
 * Version invariants every reader enforces. A v1 file carrying a VM record would be run on
 * the host by an older build, and Default always runs on the host.
 */
export function profileRegistryVersionViolation(registry: {
  readonly version: number;
  readonly profiles: ReadonlyArray<Pick<ProfileRecord, "executionEnvironment" | "isDefault">>;
}): string | undefined {
  if (
    registry.version !== PROFILE_REGISTRY_VERSION_HOST &&
    registry.version !== PROFILE_REGISTRY_VERSION_LINUX_VM
  )
    return "Unsupported registry version.";
  if (registry.profiles.some((p) => p.isDefault && isLinuxVmProfile(p)))
    return "Default must run on the host.";
  if (registry.version === PROFILE_REGISTRY_VERSION_HOST && registry.profiles.some(isLinuxVmProfile))
    return "A version 1 registry cannot contain Linux VM profiles.";
  return undefined;
}
