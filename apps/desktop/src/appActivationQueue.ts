import type { DesktopAppActivationRequest } from "@t3tools/contracts";
export interface AppActivationEntry {
  request: DesktopAppActivationRequest;
  profileId: string;
  senderId?: number;
  complete: (error?: string) => void;
}
export function takeAppActivations(
  entries: Map<string, AppActivationEntry>,
  profileId: string,
  senderId: number,
) {
  return [...entries.values()]
    .filter((entry) => {
      if (
        entry.profileId !== profileId ||
        (entry.senderId !== undefined && entry.senderId !== senderId)
      )
        return false;
      entry.senderId = senderId;
      return true;
    })
    .map((entry) => entry.request);
}
export function completeAppActivation(
  entries: Map<string, AppActivationEntry>,
  profileId: string,
  senderId: number,
  id: string,
  error?: string,
) {
  const entry = entries.get(id);
  if (entry?.profileId === profileId && entry.senderId === senderId) entry.complete(error);
}
