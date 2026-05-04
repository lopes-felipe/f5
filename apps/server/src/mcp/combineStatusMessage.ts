export function combineStatusMessage(
  ...parts: ReadonlyArray<string | undefined>
): string | undefined {
  const normalized = parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  return normalized.length > 0 ? normalized.join(" ") : undefined;
}
