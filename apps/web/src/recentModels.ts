/**
 * Recently picked models, most recent first. The model picker records a pick
 * here and lists these above Favorites so switching back needs no browsing.
 */
import type { ProviderInstanceId } from "@t3tools/contracts";

export interface RecentModel {
  readonly provider: ProviderInstanceId;
  readonly model: string;
}

export const MAX_RECENT_MODELS = 3;

/** Moves the pick to the front, drops an older copy of it and keeps at most three. */
export function recordRecentModel(
  recents: ReadonlyArray<RecentModel>,
  provider: ProviderInstanceId,
  model: string,
): ReadonlyArray<RecentModel> {
  return [
    { provider, model },
    ...recents.filter((entry) => entry.provider !== provider || entry.model !== model),
  ].slice(0, MAX_RECENT_MODELS);
}

/** True when recording the pick would leave the stored list unchanged. */
export function isMostRecentModel(
  recents: ReadonlyArray<RecentModel>,
  provider: ProviderInstanceId,
  model: string,
): boolean {
  const first = recents[0];
  return first !== undefined && first.provider === provider && first.model === model;
}
