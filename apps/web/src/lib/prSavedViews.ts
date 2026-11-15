import { Schema } from "effect";

/** The parts of the queue's URL state a saved view keeps: its search and its filters. */
export const PR_SAVED_VIEW_FILTERS = [
  "q",
  "repo",
  "author",
  "label",
  "ci",
  "review",
  "draft",
] as const;
export type PrSavedViewFilter = (typeof PR_SAVED_VIEW_FILTERS)[number];

export const MAX_PR_SAVED_VIEWS = 12;
export const MAX_PR_SAVED_VIEW_NAME_LENGTH = 40;

export const PrSavedViewSettingSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** Filter name to value, as in the Pull requests address. */
  query: Schema.Record(Schema.String, Schema.String),
});
export type PrSavedViewSetting = typeof PrSavedViewSettingSchema.Type;

/** A view's name as stored: trimmed, single-spaced and short enough for a tab. */
export function normalizePrSavedViewName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, MAX_PR_SAVED_VIEW_NAME_LENGTH);
}

/**
 * Keeps the saved views that can still be shown. A stored view with no name, no filter or
 * a repeated id is dropped on its own, so one bad entry never resets the others.
 */
export function normalizePrSavedViews(value: unknown): ReadonlyArray<PrSavedViewSetting> {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  const views: PrSavedViewSetting[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const { id, name, query } = item as Record<string, unknown>;
    if (typeof id !== "string" || !id || id.length > 64 || ids.has(id)) continue;
    if (typeof name !== "string" || !query || typeof query !== "object") continue;
    const label = normalizePrSavedViewName(name);
    const filters = Object.fromEntries(
      PR_SAVED_VIEW_FILTERS.flatMap((filter) => {
        const filterValue = (query as Record<string, unknown>)[filter];
        return typeof filterValue === "string" && filterValue.trim() && filterValue.length <= 500
          ? [[filter, filterValue] as const]
          : [];
      }),
    );
    if (!label || Object.keys(filters).length === 0) continue;
    ids.add(id);
    views.push({ id, name: label, query: filters });
    if (views.length === MAX_PR_SAVED_VIEWS) break;
  }
  return views;
}
