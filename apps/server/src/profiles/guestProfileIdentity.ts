import { ProfileId, type ProfileListResult, type ProfileSummary } from "@t3tools/contracts";
import { Schema } from "effect";

/** `F5_EXECUTION_ENVIRONMENT` as the VM guest launcher (`f5-guest launch`) sets it. */
export const LINUX_VM_GUEST_ENVIRONMENT = "linux-vm-guest";

/** What a guest backend shows for its profile until it can read the host's record. */
export const GUEST_PROFILE_NAME = "Linux VM";

export const GUEST_PROFILE_MUTATION_REFUSAL =
  "Profiles are managed from a host profile. A Linux VM profile can't create, change or delete profiles.";

export type GuestProfileIdentity =
  | { readonly ok: true; readonly profileId: ProfileId | undefined }
  | { readonly ok: false; readonly message: string };

/**
 * The host profile a backend serves when it runs in a Linux VM guest, or `undefined` on the
 * host. The guest keeps its own registry and storage, whose only profile is its own Default,
 * so that record's id means nothing to the host window. The launcher passes the host's id
 * instead, and the backend reports that one. A guest launch without a valid id refuses to
 * start rather than report the guest's Default.
 */
export function resolveGuestProfileIdentity(env: {
  readonly executionEnvironment?: string | undefined;
  readonly desktopProfileId?: string | undefined;
}): GuestProfileIdentity {
  if (env.executionEnvironment?.trim() !== LINUX_VM_GUEST_ENVIRONMENT)
    return { ok: true, profileId: undefined };
  const decoded = Schema.decodeUnknownOption(ProfileId)(env.desktopProfileId);
  if (decoded._tag === "None")
    return {
      ok: false,
      message: "This Linux VM guest backend was started without the profile it serves.",
    };
  return { ok: true, profileId: decoded.value };
}

/**
 * The guest's active profile as the host's VM profile. The guest's slug, name and Default
 * flag are replaced. `sharedRepositories` compares records of the guest registry, so it's
 * dropped. `stateDir`, `invalidDirectories` and `providerAccounts` describe this profile's
 * real storage, projects and accounts inside the VM, so they stay.
 */
export function guestActiveProfile(
  profile: ProfileSummary,
  profileId: ProfileId,
  port: number,
): ProfileSummary {
  const { sharedRepositories: _guestRegistryOnly, ...rest } = profile;
  return {
    ...rest,
    id: profileId,
    slug: "linux-vm",
    name: GUEST_PROFILE_NAME,
    isDefault: false,
    executionEnvironment: "linux-vm",
    // The welcome schema rejects port 0, which a listener bound to an OS-assigned port reports
    // (tests do this; `f5-guest` always passes a fixed port).
    port: port > 0 ? port : profile.port,
  };
}

/**
 * The profile list a guest backend answers: only its active profile, reported as the host's
 * VM profile. The guest registry's diagnostic is dropped too: it describes a file the host
 * window can't repair, and profile changes are refused here anyway.
 */
export function guestProfileSnapshot(
  snapshot: typeof ProfileListResult.Type,
  profileId: ProfileId,
  port: number,
): typeof ProfileListResult.Type {
  const active = snapshot.profiles.find((profile) => profile.isActive);
  return { profiles: active ? [guestActiveProfile(active, profileId, port)] : [] };
}
