export function normalizeOptionalString(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeOptionalStringArray(
  values: ReadonlyArray<string> | null | undefined,
): string[] | undefined {
  if (!Array.isArray(values)) {
    return undefined;
  }

  const normalized = values
    .map((value) => normalizeOptionalString(value))
    .filter((value): value is string => value !== undefined);
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeStringRecord(
  value: Record<string, string> | null | undefined,
): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const normalized = Object.fromEntries(
    Object.entries(value)
      .map(([key, entryValue]) => {
        const normalizedKey = normalizeOptionalString(key);
        if (!normalizedKey || typeof entryValue !== "string") {
          return null;
        }
        return [normalizedKey, entryValue] as const;
      })
      .filter((entry): entry is readonly [string, string] => entry !== null),
  );
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}
