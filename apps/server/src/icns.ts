const ICNS_HEADER_BYTES = 8;
const ICNS_MAGIC = 0x69636e73; // "icns"
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
// Signature, IHDR length and type, then the 4-byte width.
const PNG_WIDTH_OFFSET = 16;

function pngWidth(entry: Uint8Array): number | null {
  if (entry.length < PNG_WIDTH_OFFSET + 4) return null;
  if (PNG_SIGNATURE.some((byte, index) => entry[index] !== byte)) return null;
  return new DataView(entry.buffer, entry.byteOffset, entry.byteLength).getUint32(PNG_WIDTH_OFFSET);
}

/**
 * Picks the smallest embedded PNG at least `minSize` wide, else the largest; null when the
 * `.icns` has none (older icon types store raw bitmaps). Returns a copy so the response
 * does not pin the whole file.
 */
export function extractIcnsPng(bytes: Uint8Array, minSize: number): Uint8Array | null {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < ICNS_HEADER_BYTES || data.getUint32(0) !== ICNS_MAGIC) return null;
  const end = Math.min(data.getUint32(4), bytes.length);
  let best: { readonly png: Uint8Array; readonly width: number } | null = null;
  for (let offset = ICNS_HEADER_BYTES; offset + ICNS_HEADER_BYTES <= end; ) {
    const length = data.getUint32(offset + 4);
    if (length < ICNS_HEADER_BYTES || offset + length > end) break;
    const entry = bytes.subarray(offset + ICNS_HEADER_BYTES, offset + length);
    offset += length;
    const width = pngWidth(entry);
    if (width === null) continue;
    const isBetter =
      best === null ||
      (best.width < minSize ? width > best.width : width >= minSize && width < best.width);
    if (isBetter) best = { png: entry, width };
  }
  return best?.png.slice() ?? null;
}
