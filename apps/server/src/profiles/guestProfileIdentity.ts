import { ProfileId, type ProfileSummary } from "@t3tools/contracts";
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
 * The profile list a guest backend answers: its own active profile, reported as the host's
 * VM profile. The guest's other records (only its Default) never leave the guest, and the
 * host's other profiles aren't visible from here.
 */
export function guestProfileSnapshot<
  T extends { readonly profiles: ReadonlyArray<ProfileSummary> },
>(snapshot: T, profileId: ProfileId, port: number): T {
  const active = snapshot.profiles.find((profile) => profile.isActive);
  return {
    ...snapshot,
    profiles: active
      ? [
          {
            ...active,
            id: profileId,
            slug: "linux-vm",
            name: GUEST_PROFILE_NAME,
            isDefault: false,
            executionEnvironment: "linux-vm",
            // 0 asks the OS for a port; the record's own port stays the valid one then.
            port: port > 0 ? port : active.port,
          },
        ]
      : [],
  };
}
