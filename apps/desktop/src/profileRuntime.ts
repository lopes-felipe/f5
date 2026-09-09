import type { ProfileRecord } from "@t3tools/contracts";
export const MAX_ACTIVE_PROFILE_BACKENDS = 6;
export const profilePartition = (profile: Pick<ProfileRecord, "id" | "isDefault">) =>
  profile.isDefault ? undefined : `persist:f5-profile-${profile.id}`;
export const profilePreviewPartition = (profile: Pick<ProfileRecord, "id" | "isDefault">) =>
  profile.isDefault ? "persist:f5-preview" : `persist:f5-profile-preview-${profile.id}`;
export const profileWindowArguments = (profileId: string) => [`--f5-profile-id=${profileId}`];

/** Existing windows retain their preload URL when a stopped backend reopens. */
export async function ensureProfileConnection(
  runtime: { backendPort: number; backendAuthToken: string; backendWsUrl: string },
  reservePort: () => Promise<number>,
  mintToken: () => string,
  websocketUrl: (port: number, token: string) => string,
): Promise<void> {
  if (!runtime.backendPort) runtime.backendPort = await reservePort();
  if (!runtime.backendAuthToken) runtime.backendAuthToken = mintToken();
  runtime.backendWsUrl = websocketUrl(runtime.backendPort, runtime.backendAuthToken);
}

/** Coalesce concurrent window/menu requests before asynchronous port allocation. */
export function singleProfileOpen<T>(open: (id: string) => Promise<T>): (id: string) => Promise<T> {
  const pending = new Map<string, Promise<T>>();
  return (id) => {
    const existing = pending.get(id);
    if (existing) return existing;
    const result = Promise.resolve().then(() => open(id));
    pending.set(id, result);
    void result
      .finally(() => {
        if (pending.get(id) === result) pending.delete(id);
      })
      .catch(() => {});
    return result;
  };
}
