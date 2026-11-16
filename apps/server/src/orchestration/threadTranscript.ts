/** Helpers for reading one thread's transcript on behalf of another agent. */

export function truncateUtf8(
  text: string,
  maxBytes: number,
): { readonly text: string; readonly truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  const bytes = Buffer.from(text, "utf8");
  // Back up to the start of the character the cut lands in, so a multi-byte sequence is never
  // split. Real U+FFFD characters in the text stay.
  let end = Math.max(0, maxBytes);
  while (end > 0 && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end--;
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}
