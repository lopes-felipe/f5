import type { DiskSpaceVolumeRole } from "@t3tools/contracts";

/** What F5 keeps on a watched volume, as shown to the user. */
export const DISK_SPACE_ROLE_LABELS: Record<DiskSpaceVolumeRole, string> = {
  userdata: "F5 data",
  claudeHome: "Claude home",
  codexHome: "Codex home",
};

export function describeDiskSpaceRoles(roles: ReadonlyArray<DiskSpaceVolumeRole>): string {
  return roles.map((role) => DISK_SPACE_ROLE_LABELS[role]).join(", ");
}
