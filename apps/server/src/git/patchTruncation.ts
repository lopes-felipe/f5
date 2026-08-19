/** Bounds review patches without returning an empty artifact for one large file. */
export const REVIEW_PATCH_LIMIT_BYTES = 120 * 1024;

function truncatePatchSection(section: string, limitBytes: number, marker: string): string {
  const markerBytes = Buffer.byteLength(marker);
  const bodyBudget = Math.max(0, limitBytes - markerBytes);
  const headBudget = Math.floor(bodyBudget * 0.7);
  const tailBudget = bodyBudget - headBudget;
  const buffer = Buffer.from(section);
  const head = buffer
    .subarray(0, headBudget)
    .toString("utf8")
    .replace(/\uFFFD+$/g, "");
  const tail = buffer
    .subarray(Math.max(0, buffer.length - tailBudget))
    .toString("utf8")
    .replace(/^\uFFFD+/g, "");
  return `${head}${marker}${tail}`;
}

export function truncatePatchAtFileBoundary(
  patch: string,
  sourceTruncated: boolean,
  limitBytes = REVIEW_PATCH_LIMIT_BYTES,
): { readonly patch: string; readonly truncated: boolean; readonly reason: string | null } {
  if (!sourceTruncated && Buffer.byteLength(patch) <= limitBytes) {
    return { patch, truncated: false, reason: null };
  }

  const originalBytes = Buffer.byteLength(patch);
  const starts = [...patch.matchAll(/^diff --git /gm)].map((match) => match.index);
  let output = starts[0] && starts[0] > 0 ? patch.slice(0, starts[0]) : "";
  const completeSectionCount = sourceTruncated ? Math.max(0, starts.length - 1) : starts.length;
  for (let index = 0; index < completeSectionCount; index += 1) {
    const start = starts[index]!;
    const end = starts[index + 1] ?? patch.length;
    const section = patch.slice(start, end);
    if (Buffer.byteLength(output) + Buffer.byteLength(section) > limitBytes) break;
    output += section;
  }
  if (output.length === 0 || (starts[0] && output === patch.slice(0, starts[0]))) {
    const firstRelevantSection =
      starts.length > 0 ? patch.slice(starts[0], starts[1] ?? patch.length) : patch;
    const marker = "\n[... oversized file patch middle omitted ...]\n";
    output = truncatePatchSection(firstRelevantSection, limitBytes, marker);
  }
  const retainedBytes = Buffer.byteLength(output);
  return {
    patch: output,
    truncated: true,
    reason: `Patch was truncated (${originalBytes} original bytes, ${retainedBytes} retained bytes, ${Math.max(0, originalBytes - retainedBytes)} omitted bytes; ${limitBytes} byte limit).`,
  };
}
