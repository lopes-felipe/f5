/** Acceptance reports certify an existing candidate; they never create a beta source. */
export function acceptanceOnlyFiles(names: readonly string[]): boolean {
  return (
    names.length > 0 &&
    names.every((name) => /^docs\/computer-certification\/acceptance-[^/]+\.json$/.test(name))
  );
}
