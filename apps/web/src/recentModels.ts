/**
 * Recently picked models, most recent first. The model picker lists these
 * above Favorites so switching back needs no browsing.
 *
 * This is separate from `modelPreferencesStore.recentModelSelections` on
 * purpose. That list is the two-entry register behind `model.switchRecent`
 * (alt+tab): it is keyed by driver kind, treats the same model with a
 * different effort as a separate entry, and must stay at two entries for the
 * swap. Recent here names provider instances (so a custom Codex instance is
 * not folded into the default one), ignores effort and keeps three. To keep
 * the two in step, the composer records here on every model pick it applies
 * (picker, alt+tab, favorite shortcuts), not only on picker clicks.
 */
import type { ProviderInstanceId } from "@t3tools/contracts";

import { readAppSettingsSnapshot, updateAppSettings } from "./appSettings";

export interface RecentModel {
  readonly provider: ProviderInstanceId;
  readonly model: string;
}

export const MAX_RECENT_MODELS = 3;

/**
 * Moves the pick to the front, drops an older copy of it and any entry
 * `isStale` rejects, and keeps at most three.
 */
export function recordRecentModel(
  recents: ReadonlyArray<RecentModel>,
  provider: ProviderInstanceId,
  model: string,
  isStale: (recent: RecentModel) => boolean = () => false,
): ReadonlyArray<RecentModel> {
  return [
    { provider, model },
    ...recents.filter(
      (entry) => (entry.provider !== provider || entry.model !== model) && !isStale(entry),
    ),
  ].slice(0, MAX_RECENT_MODELS);
}

export function isSameRecentModels(
  left: ReadonlyArray<RecentModel>,
  right: ReadonlyArray<RecentModel>,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.provider === right[index]?.provider && entry.model === right[index]?.model,
    )
  );
}

/** Records an applied pick in the stored Recent list, writing only when it changes. */
export function rememberRecentModel(provider: ProviderInstanceId, model: string): void {
  const current = readAppSettingsSnapshot().recentModels;
  const next = recordRecentModel(current, provider, model);
  if (!isSameRecentModels(next, current)) updateAppSettings({ recentModels: next });
}
