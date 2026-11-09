import { afterEach, expect, it, vi } from "vitest";
import { decodeHeicPreview, validateHeicDimensions } from "./heicPreview";
import { MAX_COMPRESSIBLE_IMAGE_SOURCE_BYTES } from "./imageCompression.core";
import { processComposerImageTaskBounded } from "./imageCompression";

const decoder = vi.hoisted(() => ({ decode: vi.fn() }));
vi.mock("heic-to/csp", () => ({ heicTo: decoder.decode }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  decoder.decode.mockReset();
});

function metadata(width: number, height: number) {
  const bytes = new ArrayBuffer(20);
  const view = new DataView(bytes);
  view.setUint32(0, 20);
  new Uint8Array(bytes, 4, 4).set([105, 115, 112, 101]); // ispe
  view.setUint32(12, width);
  view.setUint32(16, height);
  return bytes;
}

function container(type: string, child: ArrayBuffer, fullBox = false): ArrayBuffer {
  const header = fullBox ? 12 : 8;
  const bytes = new ArrayBuffer(header + child.byteLength);
  const view = new DataView(bytes);
  view.setUint32(0, bytes.byteLength);
  new Uint8Array(bytes, 4, 4).set([...type].map((letter) => letter.charCodeAt(0)));
  new Uint8Array(bytes, header).set(new Uint8Array(child));
  return bytes;
}

it("checks spatial extents nested under a meta FullBox, iprp, and ipco", () => {
  const nested = (width: number) =>
    container("meta", container("iprp", container("ipco", metadata(width, 8000))), true);
  expect(() => validateHeicDimensions(nested(8000))).not.toThrow();
  expect(() => validateHeicDimensions(nested(8001))).toThrow("pixel limit");
});

it("rejects missing, malformed, and excessive spatial extents before decoding", () => {
  expect(() => validateHeicDimensions(metadata(8000, 8000))).not.toThrow();
  expect(() => validateHeicDimensions(metadata(8001, 8000))).toThrow("pixel limit");
  expect(() => validateHeicDimensions(metadata(0, 100))).toThrow();
  expect(() => validateHeicDimensions(new ArrayBuffer(0))).toThrow("could not be verified");
  expect(() => validateHeicDimensions(metadata(100, 100).slice(0, 19))).toThrow();
  expect(decoder.decode).not.toHaveBeenCalled();
});

it("rejects oversized source blobs without loading the decoder", async () => {
  const blob = new Blob([new Uint8Array(MAX_COMPRESSIBLE_IMAGE_SOURCE_BYTES + 1)]);
  expect(await decodeHeicPreview(blob, "big.heic", new AbortController().signal)).toEqual({
    ok: false,
    reason: "too-large",
  });
  expect(decoder.decode).not.toHaveBeenCalled();
});

it("bounds non-interruptible decodes even when their callers cancel", async () => {
  const release: Array<() => void> = [];
  const close = vi.fn();
  decoder.decode.mockImplementation(
    () =>
      new Promise((resolve) => {
        release.push(() => resolve({ width: 100, height: 100, close }));
      }),
  );
  const blob = new Blob([metadata(100, 100)]);
  const controllers = [new AbortController(), new AbortController()];
  const pending = controllers.map((controller) =>
    decodeHeicPreview(blob, "image.heic", controller.signal),
  );
  await vi.waitFor(() => expect(decoder.decode).toHaveBeenCalledTimes(2));
  controllers.forEach((controller) => controller.abort());
  expect(await decodeHeicPreview(blob, "extra.heic", new AbortController().signal)).toEqual({
    ok: false,
    reason: "busy",
  });
  release.forEach((finish) => finish());
  expect(await Promise.all(pending)).toEqual([
    { ok: false, reason: "cancelled" },
    { ok: false, reason: "cancelled" },
  ]);
  expect(close).toHaveBeenCalledTimes(2);
});

it("limits concurrent decodes, scales to the attachment edge, and closes each bitmap", async () => {
  const draw = vi.fn();
  const canvases: Array<{ width: number; height: number }> = [];
  vi.stubGlobal("document", {
    createElement: () => {
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: draw }),
        toBlob: (callback: (blob: Blob) => void) =>
          callback(new Blob(["jpeg"], { type: "image/jpeg" })),
      };
      canvases.push(canvas);
      return canvas;
    },
  });
  const release: Array<() => void> = [];
  const close = vi.fn();
  decoder.decode.mockImplementation(
    () =>
      new Promise((resolve) => {
        release.push(() => resolve({ width: 4000, height: 2000, close }));
      }),
  );
  const blob = new Blob([metadata(4000, 2000)]);
  const pending = Array.from({ length: 3 }, () => {
    const signal = new AbortController().signal;
    return processComposerImageTaskBounded(
      () => decodeHeicPreview(blob, "image.heic", signal),
      signal,
    );
  });
  await vi.waitFor(() => expect(decoder.decode).toHaveBeenCalledTimes(2));
  release[0]!();
  expect((await pending[0])?.ok).toBe(true);
  await vi.waitFor(() => expect(decoder.decode).toHaveBeenCalledTimes(3));
  release[1]!();
  release[2]!();
  const results = await Promise.all(pending);
  expect(results.every((result) => result.ok)).toBe(true);
  expect(canvases).toEqual(
    expect.arrayContaining([expect.objectContaining({ width: 2000, height: 1000 })]),
  );
  expect(close).toHaveBeenCalledTimes(3);
});
