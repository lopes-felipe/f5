/** Provider descriptions are optional; the shared question contract requires nonblank text. */
export function normalizeUserInputOptions(options: ReadonlyArray<Record<string, unknown>>) {
  return options.flatMap((option) => {
    const label = typeof option.label === "string" ? option.label.trim() : "";
    if (!label) return [];
    const description = typeof option.description === "string" ? option.description.trim() : "";
    return [{ label, description: description || label }];
  });
}
