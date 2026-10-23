export type PiRpcRecord = Record<string, unknown>;
export function piRecordField(record: unknown, field: string): unknown {
  return record !== null && typeof record === "object" && !Array.isArray(record)
    ? (record as PiRpcRecord)[field]
    : undefined;
}
export function piRecordString(record: unknown, field: string): string | undefined {
  const value = piRecordField(record, field);
  return typeof value === "string" ? value : undefined;
}
export function piRecordNumber(record: unknown, field: string): number | undefined {
  const value = piRecordField(record, field);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
export function parsePiModelSlug(slug: string): { provider: string; modelId: string } | null {
  const separator = slug.indexOf("/");
  return separator <= 0 || separator === slug.length - 1
    ? null
    : { provider: slug.slice(0, separator), modelId: slug.slice(separator + 1) };
}
