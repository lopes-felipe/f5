import { afterEach, describe, expect, it, vi } from "vitest";

import {
  COMPOSER_IMAGE_OUTPUT_MIME_TYPE,
  imageDataUrlCharLength,
  isAnimatedGif,
  isAnimatedWebP,
  processImageForComposerInWorker,
} from "./imageCompression.core";

function gifWithFrames(frameCount: number): Uint8Array {
  const bytes = Array.from(new TextEncoder().encode("GIF89a"));
  bytes.push(1, 0, 1, 0, 0, 0, 0);
  for (let index = 0; index < frameCount; index += 1) {
    bytes.push(0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0);
    bytes.push(2, 1, 0, 0);
  }
  bytes.push(0x3b);
  return Uint8Array.from(bytes);
}

function animatedWebP(): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  bytes.set(new TextEncoder().encode("WEBP"), 8);
  bytes.set(new TextEncoder().encode("VP8X"), 12);
  bytes[16] = 10;
  bytes[20] = 0x02;
  return bytes;
}

function bytesAsArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("image compression format guards", () => {
  it("counts the exact base64 data URL length", () => {
    expect(imageDataUrlCharLength(3, "image/png")).toBe("data:image/png;base64,".length + 4);
    expect(imageDataUrlCharLength(4, "image/png")).toBe("data:image/png;base64,".length + 8);
  });

  it("distinguishes static and animated GIFs", () => {
    expect(isAnimatedGif(gifWithFrames(1))).toBe(false);
    expect(isAnimatedGif(gifWithFrames(2))).toBe(true);
  });

  it("detects the WebP animation feature bit", () => {
    expect(isAnimatedWebP(animatedWebP())).toBe(true);
  });
});

describe("processImageForComposerInWorker", () => {
  it("preserves a supported static image that fits both transport caps", async () => {
    const file = new Blob([bytesAsArrayBuffer(gifWithFrames(1))], { type: "image/gif" });
    await expect(
      processImageForComposerInWorker({
        file,
        mimeType: file.type,
        maxBytes: 1024,
        maxDataUrlChars: 2048,
      }),
    ).resolves.toEqual({ ok: true, useOriginal: true, mimeType: "image/gif" });
  });

  it("refuses animated images instead of flattening the first frame", async () => {
    const file = new Blob([bytesAsArrayBuffer(gifWithFrames(2))], { type: "image/gif" });
    await expect(
      processImageForComposerInWorker({
        file,
        mimeType: file.type,
        maxBytes: 1024,
        maxDataUrlChars: 2048,
      }),
    ).resolves.toEqual({ ok: false, reason: "animated" });
  });

  it("honours orientation before encoding and enforces both output caps", async () => {
    const close = vi.fn();
    const createImageBitmapMock = vi.fn().mockResolvedValue({ width: 3000, height: 2000, close });
    const dimensions: Array<[number, number]> = [];
    class FakeOffscreenCanvas {
      constructor(
        readonly width: number,
        readonly height: number,
      ) {
        dimensions.push([width, height]);
      }
      getContext() {
        return { drawImage: vi.fn() };
      }
      async convertToBlob() {
        return new Blob([new Uint8Array(100)], { type: COMPOSER_IMAGE_OUTPUT_MIME_TYPE });
      }
    }
    vi.stubGlobal("createImageBitmap", createImageBitmapMock);
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);

    const result = await processImageForComposerInWorker({
      file: new Blob([new Uint8Array(150)], { type: "image/bmp" }),
      mimeType: "image/bmp",
      maxBytes: 120,
      maxDataUrlChars: imageDataUrlCharLength(100, COMPOSER_IMAGE_OUTPUT_MIME_TYPE),
    });

    expect(result).toMatchObject({
      ok: true,
      useOriginal: false,
      mimeType: COMPOSER_IMAGE_OUTPUT_MIME_TYPE,
    });
    expect(createImageBitmapMock).toHaveBeenCalledWith(expect.any(Blob), {
      imageOrientation: "from-image",
    });
    expect(dimensions[0]).toEqual([2048, 1365]);
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects an encoding whose exact serialized size exceeds the character cap", async () => {
    const close = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn().mockResolvedValue({ width: 3000, height: 2000, close }),
    );
    const dimensions: Array<[number, number]> = [];
    class FakeOffscreenCanvas {
      constructor(
        readonly width: number,
        readonly height: number,
      ) {
        dimensions.push([width, height]);
      }
      getContext() {
        return { drawImage: vi.fn() };
      }
      async convertToBlob() {
        return new Blob([new Uint8Array(100)], { type: COMPOSER_IMAGE_OUTPUT_MIME_TYPE });
      }
    }
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);

    await expect(
      processImageForComposerInWorker({
        file: new Blob([new Uint8Array(150)], { type: "image/bmp" }),
        mimeType: "image/bmp",
        maxBytes: 120,
        maxDataUrlChars: imageDataUrlCharLength(100, COMPOSER_IMAGE_OUTPUT_MIME_TYPE) - 1,
      }),
    ).resolves.toEqual({ ok: false, reason: "too-large" });
    expect(dimensions).toEqual([
      [2048, 1365],
      [1536, 1024],
      [1024, 683],
    ]);
    expect(close).toHaveBeenCalledOnce();
  });
});
