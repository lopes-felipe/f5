type UnknownRecord = Record<string, unknown>;

export function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

export function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function asNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function asNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function asDecimalCount(value: unknown): string | null {
  if (typeof value === "bigint" && value >= 0n) return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value.toString();
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return value.trim();
  return null;
}

export function asIsoDateTime(value: unknown): string | null {
  const text = asTrimmedString(value);
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : null;
}

/** Normalize epoch timestamps or provider ISO dates without throwing on invalid input. */
export function resetDate(value: unknown, unit: "ms" | "s" = "ms"): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const time = typeof value === "number" ? value * (unit === "s" ? 1000 : 1) : Date.parse(value);
  return Number.isFinite(time) && Math.abs(time) < 8.64e15 ? new Date(time).toISOString() : null;
}
