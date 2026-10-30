/** Helpers for reading one thread's transcript on behalf of another agent. */

export function truncateUtf8(
  text: string,
  maxBytes: number,
): { readonly text: string; readonly truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  const bytes = Buffer.from(text, "utf8").subarray(0, maxBytes);
  // Drop a trailing partial multi-byte sequence.
  return { text: bytes.toString("utf8").replace(/�+$/u, ""), truncated: true };
}
