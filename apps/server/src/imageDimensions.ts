import type { FileHandle } from "node:fs/promises";

/** Header-only decoding. No image decompression or unbounded allocation in asset authorization. */
export function imageDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  let width = 0,
    height = 0;
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString("ascii", 12, 16) === "IHDR"
  ) {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else if (bytes.length >= 10 && /^GIF8[79]a$/u.test(bytes.toString("ascii", 0, 6))) {
    width = bytes.readUInt16LE(6);
    height = bytes.readUInt16LE(8);
  } else if (
    bytes.length >= 30 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    const kind = bytes.toString("ascii", 12, 16);
    if (kind === "VP8X") {
      width = bytes.readUIntLE(24, 3) + 1;
      height = bytes.readUIntLE(27, 3) + 1;
    } else if (kind === "VP8 ") {
      width = bytes.readUInt16LE(26) & 0x3fff;
      height = bytes.readUInt16LE(28) & 0x3fff;
    } else if (kind === "VP8L" && bytes[20] === 47) {
      const packed = bytes.readUInt32LE(21);
      width = (packed & 0x3fff) + 1;
      height = ((packed >>> 14) & 0x3fff) + 1;
    }
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    let rotated = false;
    for (let offset = 2; offset + 4 <= bytes.length; ) {
      if (bytes[offset] !== 255) break;
      const marker = bytes[offset + 1]!;
      if (marker === 255) {
        offset++;
        continue;
      }
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) {
        offset += 2;
        continue;
      }
      const length = bytes.readUInt16BE(offset + 2),
        end = offset + 2 + length;
      if (length < 2 || end > bytes.length) break;
      if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker) && length >= 7) {
        width = bytes.readUInt16BE(offset + 7);
        height = bytes.readUInt16BE(offset + 5);
        if (rotated) [width, height] = [height, width];
        break;
      }
      if (
        marker === 225 &&
        bytes.toString("ascii", offset + 4, offset + 10) === "Exif\0\0" &&
        length >= 16
      ) {
        const tiff = offset + 10;
        const endian = bytes.toString("ascii", tiff, tiff + 2);
        if (endian === "II" || endian === "MM") {
          const u16 = (at: number) =>
            endian === "II" ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at);
          const u32 = (at: number) =>
            endian === "II" ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at);
          const ifd = tiff + u32(tiff + 4);
          if (ifd >= tiff && ifd + 2 <= end)
            for (let i = 0, n = u16(ifd); i < n; i++) {
              const entry = ifd + 2 + i * 12;
              if (entry + 12 > end) break;
              if (u16(entry) === 274 && u16(entry + 2) === 3 && u32(entry + 4) === 1) {
                const orientation = u16(entry + 8);
                rotated = orientation >= 5 && orientation <= 8;
                break;
              }
            }
        }
      }
      offset = end;
    }
  }
  return width > 0 && height > 0 && width <= 100_000 && height <= 100_000
    ? { width, height }
    : undefined;
}
export async function readAssetImageDimensions(file: FileHandle) {
  const prefix = Buffer.alloc(32);
  const first = await file.read(prefix, 0, prefix.length, 0);
  if (prefix[0] !== 255 || prefix[1] !== 216)
    return imageDimensions(prefix.subarray(0, first.bytesRead));
  const header = Buffer.alloc(Math.min((await file.stat()).size, 256 * 1024));
  const result = await file.read(header, 0, header.length, 0);
  return imageDimensions(header.subarray(0, result.bytesRead));
}
