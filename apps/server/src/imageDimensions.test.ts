import { expect, it } from "vitest";
import { imageDimensions } from "./imageDimensions";
it("reads PNG, GIF and all WebP header layouts without decoding image pixels", () => {
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.write("IHDR", 12);
  png.writeUInt32BE(640, 16);
  png.writeUInt32BE(480, 20);
  expect(imageDimensions(png)).toEqual({ width: 640, height: 480 });
  const gif = Buffer.alloc(10);
  gif.write("GIF89a");
  gif.writeUInt16LE(80, 6);
  gif.writeUInt16LE(60, 8);
  expect(imageDimensions(gif)).toEqual({ width: 80, height: 60 });
  for (const kind of ["VP8 ", "VP8L", "VP8X"]) {
    const webp = Buffer.alloc(30);
    webp.write("RIFF");
    webp.write("WEBP", 8);
    webp.write(kind, 12);
    if (kind === "VP8 ") {
      webp.writeUInt16LE(80, 26);
      webp.writeUInt16LE(60, 28);
    } else if (kind === "VP8L") {
      webp[20] = 47;
      webp.writeUInt32LE(79 | (59 << 14), 21);
    } else {
      webp.writeUIntLE(79, 24, 3);
      webp.writeUIntLE(59, 27, 3);
    }
    expect(imageDimensions(webp)).toEqual({ width: 80, height: 60 });
  }
});
it("reads JPEG frames and safely refuses truncated or malformed headers", () => {
  const jpeg = Buffer.from([255, 216, 255, 192, 0, 7, 8, 0, 60, 0, 80]);
  expect(imageDimensions(jpeg)).toEqual({ width: 80, height: 60 });
  for (let length = 0; length < jpeg.length; length++)
    expect(imageDimensions(jpeg.subarray(0, length))).toBeUndefined();
  expect(imageDimensions(Buffer.from([255, 216, 255, 225, 0, 0]))).toBeUndefined();
  expect(imageDimensions(Buffer.alloc(32))).toBeUndefined();
});
