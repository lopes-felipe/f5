/**
 * Byte-accurate middle truncation for buffered provider output.
 *
 * Shared by command-transcript projection and file-change ingestion so that
 * large streamed output cannot grow unbounded in memory or persisted rows. Keeps
 * a head and a tail around an explicit marker, trimming any partial multi-byte
 * UTF-8 sequence left at a cut boundary.
 *
 * @module outputTruncation
 */

export interface MiddleTruncationOptions {
  /** Maximum size, in UTF-8 bytes, of the returned string. */
  readonly maxBytes: number;
  /** Bytes to retain from the start before the marker. */
  readonly headBytes: number;
  /** Marker inserted between the retained head and tail. */
  readonly marker: string;
}

export interface MiddleTruncationResult {
  readonly output: string;
  readonly truncated: boolean;
}

export interface MiddleCharacterTruncationOptions {
  /** Maximum size, in UTF-16 code units, of the returned string. */
  readonly maxCharacters: number;
  /** UTF-16 code units to retain from the start before the marker. */
  readonly headCharacters: number;
  /** Marker inserted between the retained head and tail. */
  readonly marker: string;
}

function sliceWithoutBrokenSurrogate(input: string, start: number, end?: number): string {
  let safeStart = start;
  let safeEnd = end ?? input.length;
  if (
    safeStart > 0 &&
    safeStart < input.length &&
    /[\uDC00-\uDFFF]/.test(input.charAt(safeStart))
  ) {
    safeStart += 1;
  }
  if (safeEnd > 0 && safeEnd < input.length && /[\uD800-\uDBFF]/.test(input.charAt(safeEnd - 1))) {
    safeEnd -= 1;
  }
  return input.slice(safeStart, safeEnd);
}

/** UTF-16-unit counterpart to {@link truncateMiddleByBytes}. */
export function truncateMiddleByCharacters(
  output: string,
  options: MiddleCharacterTruncationOptions,
): MiddleTruncationResult {
  if (output.length <= options.maxCharacters) {
    return { output, truncated: false };
  }
  const markerCharacters = options.marker.length;
  const headCharacters = Math.min(
    options.headCharacters,
    Math.max(0, options.maxCharacters - markerCharacters),
  );
  const tailCharacters = Math.max(0, options.maxCharacters - headCharacters - markerCharacters);
  const head = sliceWithoutBrokenSurrogate(output, 0, headCharacters);
  const tail =
    tailCharacters > 0 ? sliceWithoutBrokenSurrogate(output, output.length - tailCharacters) : "";
  return { output: `${head}${options.marker}${tail}`, truncated: true };
}

/**
 * Truncates `output` to at most `maxBytes` UTF-8 bytes by keeping `headBytes`
 * from the start, the marker, and the remaining tail budget from the end.
 * Returns the input unchanged when it already fits.
 *
 * `headBytes` is clamped so that head + marker never exceeds `maxBytes`; the
 * result therefore stays within `maxBytes` (the only exception being a marker
 * that is itself larger than `maxBytes`, which is a degenerate configuration).
 */
export function truncateMiddleByBytes(
  output: string,
  options: MiddleTruncationOptions,
): MiddleTruncationResult {
  if (Buffer.byteLength(output, "utf8") <= options.maxBytes) {
    return { output, truncated: false };
  }

  const markerBytes = Buffer.byteLength(options.marker, "utf8");
  // Reserve room for the marker so head + marker <= maxBytes.
  const headBytes = Math.min(options.headBytes, Math.max(0, options.maxBytes - markerBytes));
  const tailBytes = Math.max(0, options.maxBytes - headBytes - markerBytes);
  const outputBuffer = Buffer.from(output, "utf8");
  const head = outputBuffer
    .subarray(0, headBytes)
    .toString("utf8")
    .replace(/\uFFFD+$/g, "");
  const tail =
    tailBytes > 0
      ? outputBuffer
          .subarray(outputBuffer.length - tailBytes)
          .toString("utf8")
          .replace(/^\uFFFD+/g, "")
      : "";

  return {
    output: `${head}${options.marker}${tail}`,
    truncated: true,
  };
}
