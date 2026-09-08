import type { ProfileRecord } from "@t3tools/contracts";
export const MAX_ACTIVE_PROFILE_BACKENDS = 6;
export const profilePartition = (profile: Pick<ProfileRecord, "id" | "isDefault">) =>
  profile.isDefault ? undefined : `persist:f5-profile-${profile.id}`;
export const profilePreviewPartition = (profile: Pick<ProfileRecord, "id" | "isDefault">) =>
  profile.isDefault ? "persist:f5-preview" : `persist:f5-profile-preview-${profile.id}`;
export const profileWindowArguments = (profileId: string, wsUrl: string) => [
  `--f5-profile-id=${profileId}`,
  `--f5-ws-url=${wsUrl}`,
];
