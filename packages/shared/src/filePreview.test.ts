import { expect, it } from "vitest";

import {
  filePreviewExtension,
  isImagePreviewPath,
  isSvgPreview,
  videoPreviewMimeType,
} from "./filePreview";

it("recognizes previewable images by the basename's extension only", () => {
  expect(isImagePreviewPath("/repo/docs/Screenshot.PNG")).toBe(true);
  expect(isImagePreviewPath("C:\\repo\\chart.webp")).toBe(true);
  expect(isImagePreviewPath("photo.heic")).toBe(false);
  expect(isImagePreviewPath("images.png/notes.txt")).toBe(false);
  expect(isImagePreviewPath(".png")).toBe(false);
  expect(filePreviewExtension("archive.tar.gz")).toBe("gz");
  expect(filePreviewExtension("Makefile")).toBeUndefined();
});

it.each(["video/mp2t", "video/vnd.dlna.mpeg-tts", " VIDEO/MP2T; charset=utf-8"])(
  "classifies TypeScript using its extension for ambiguous MIME %s",
  (mimeType) => {
    expect(videoPreviewMimeType({ name: "clamp.ts", mimeType })).toBeNull();
    expect(videoPreviewMimeType({ name: "clip.mp4", mimeType })).toBe("video/mp4");
  },
);

it("preserves explicit video MIME types", () => {
  expect(videoPreviewMimeType({ name: "clip", mimeType: "video/webm" })).toBe("video/webm");
});

it.each(["/work/pipeline.svg", "/work/diagram#v2.svg", "/work/diagram?v2.svg"])(
  "identifies SVG file references with opaque URLs: %s",
  (name) => {
    expect(isSvgPreview({ name, src: "blob:opaque" })).toBe(true);
  },
);

it("uses SVG metadata and URL fallbacks while respecting explicit raster types", () => {
  expect(isSvgPreview({ name: "Diagram", src: "blob:opaque", mimeType: "image/svg+xml" })).toBe(
    true,
  );
  expect(
    isSvgPreview({ name: "Diagram", src: "https://example.com/diagram.svg?v=2#preview" }),
  ).toBe(true);
  expect(isSvgPreview({ name: "Diagram", src: "data:image/svg+xml,%3Csvg/%3E" })).toBe(true);
  expect(isSvgPreview({ name: "diagram.svg", src: "blob:opaque", mimeType: "image/png" })).toBe(
    false,
  );
  expect(isSvgPreview({ name: "Diagram", src: "blob:opaque" })).toBe(false);
});
