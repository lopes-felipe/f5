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

/** OS MIME guesses for .ts files are ambiguous; use the extension instead. */
export function videoPreviewMimeType(file: { name: string; mimeType: string }): string | null {
  const mime = file.mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const generic =
    !mime ||
    [
      "application/octet-stream",
      "binary/octet-stream",
      "application/unknown",
      "video/mp2t",
      "video/vnd.dlna.mpeg-tts",
    ].includes(mime);
  if (!generic) return mime.startsWith("video/") ? mime : null;
  switch (filePreviewExtension(file.name)) {
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mov":
      return "video/quicktime";
    default:
      return null;
  }
}

export function isSvgPreview(file: { name: string; mimeType?: string; src: string }): boolean {
  const mime = file.mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mime?.startsWith("image/")) return mime === "image/svg+xml";
  if (filePreviewExtension(file.name) === "svg") return true;
  if (/^data:image\/svg\+xml[;,]/iu.test(file.src)) return true;
  try {
    return filePreviewExtension(new URL(file.src, "https://local.invalid").pathname) === "svg";
  } catch {
    return false;
  }
}
