import { expect, it } from "vitest";

import { filePreviewExtension, isImagePreviewPath } from "./filePreview";

it("recognizes previewable images by the basename's extension only", () => {
  expect(isImagePreviewPath("/repo/docs/Screenshot.PNG")).toBe(true);
  expect(isImagePreviewPath("C:\\repo\\chart.webp")).toBe(true);
  expect(isImagePreviewPath("photo.heic")).toBe(false);
  expect(isImagePreviewPath("images.png/notes.txt")).toBe(false);
  expect(isImagePreviewPath(".png")).toBe(false);
  expect(filePreviewExtension("archive.tar.gz")).toBe("gz");
  expect(filePreviewExtension("Makefile")).toBeUndefined();
});
