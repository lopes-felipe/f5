/** Raster/vector image extensions the viewer and chat render inline (HEIC stays a plain file). */
export const IMAGE_PREVIEW_EXTENSIONS: ReadonlySet<string> = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "svg",
  "ico",
]);

export function filePreviewExtension(path: string): string | undefined {
  const basename = path.split(/[\\/]/u).at(-1) ?? "";
  const dot = basename.lastIndexOf(".");
  return dot > 0 ? basename.slice(dot + 1).toLowerCase() : undefined;
}

export function isImagePreviewPath(path: string): boolean {
  const extension = filePreviewExtension(path.trim());
  return extension !== undefined && IMAGE_PREVIEW_EXTENSIONS.has(extension);
}
