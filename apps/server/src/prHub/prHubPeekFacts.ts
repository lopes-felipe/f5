const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const firstString = (...values: unknown[]): string | null =>
  values.find((value): value is string => typeof value === "string" && value.trim().length > 0) ??
  null;

export function peekIsoDate(value: unknown): string | null {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    Number.isFinite(Date.parse(value))
    ? value
    : null;
}

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Provider payloads are untrusted; malformed optional facts must never fail a preview. */
export function peekFactsFromRaw(raw: unknown) {
  const value = record(raw);
  const author = record(value.author);
  return {
    author: firstString(
      record(value.user).login,
      author.username,
      author.display_name,
      record(value.createdBy).displayName,
      author.nickname,
    ),
    isDraft:
      [value.draft, value.isDraft, value.work_in_progress].find(
        (item): item is boolean => typeof item === "boolean",
      ) ?? false,
    additions: count(value.additions),
    deletions: count(value.deletions),
    createdAt:
      [value.created_at, value.created_on, value.creationDate]
        .map(peekIsoDate)
        .find((item) => item !== null) ?? null,
    mergedAt: peekIsoDate(value.merged_at),
  };
}
