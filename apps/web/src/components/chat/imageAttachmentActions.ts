import { sanitizeDownloadFilename } from "@t3tools/shared/downloadFilename";

export interface ImageAttachmentActionItem {
  src: string;
  name: string;
  mimeType: string;
  sourceBlob?: Blob;
}

function imageActionError(message: string, cause?: unknown): Error {
  return cause === undefined ? new Error(message) : new Error(message, { cause });
}

function normalizeImageBlob(blob: Blob, fallbackMimeType: string): Blob {
  const blobMimeType = blob.type.trim().toLowerCase();
  const normalizedFallbackMimeType = fallbackMimeType.trim().toLowerCase();
  const canUseFallbackMimeType =
    blobMimeType.length === 0 || blobMimeType === "application/octet-stream";
  const mimeType = blobMimeType.startsWith("image/")
    ? blobMimeType
    : canUseFallbackMimeType && normalizedFallbackMimeType.startsWith("image/")
      ? normalizedFallbackMimeType
      : null;
  if (!mimeType) {
    throw imageActionError("The attachment did not contain a supported image.");
  }
  return blobMimeType === mimeType ? blob : blob.slice(0, blob.size, mimeType);
}

export async function fetchImageAttachmentBlob(item: ImageAttachmentActionItem): Promise<Blob> {
  if (item.sourceBlob) {
    const blob = normalizeImageBlob(item.sourceBlob, item.mimeType);
    if (blob.size === 0) {
      throw imageActionError("The image attachment is empty.");
    }
    return blob;
  }

  let response: Response;
  try {
    response = await fetch(item.src, {
      credentials: "include",
      // An <img> load can populate Chromium's cache without CORS response
      // headers. Reusing that entry for fetch() then fails before the response
      // reaches this code, even though the image is already visible.
      cache: "no-store",
    });
  } catch (error) {
    throw imageActionError("F5 could not load the image attachment.", error);
  }
  if (!response.ok) {
    throw imageActionError(
      response.status === 404
        ? "The image attachment is no longer available."
        : `F5 could not load the image attachment (HTTP ${response.status}).`,
    );
  }

  const blob = normalizeImageBlob(await response.blob(), item.mimeType);
  if (blob.size === 0) {
    throw imageActionError("The image attachment is empty.");
  }
  return blob;
}

export async function rasterizeImageBlobToPng(blob: Blob): Promise<Blob> {
  if (blob.type.trim().toLowerCase() === "image/png") {
    return blob;
  }
  if (typeof createImageBitmap !== "function") {
    throw imageActionError("This environment cannot prepare this image format for copying.");
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (error) {
    throw imageActionError("This image format could not be prepared for copying.", error);
  }

  try {
    if (bitmap.width <= 0 || bitmap.height <= 0) {
      throw imageActionError("The image has invalid dimensions and cannot be copied.");
    }
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw imageActionError("F5 could not prepare the image for copying.");
    }
    context.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((pngBlob) => {
        if (pngBlob) {
          resolve(pngBlob);
          return;
        }
        reject(imageActionError("F5 could not encode the image for copying."));
      }, "image/png");
    });
  } finally {
    bitmap.close();
  }
}

export function canCopyImageToClipboard(): boolean {
  if (typeof window !== "undefined" && typeof window.desktopBridge?.copyImage === "function") {
    return true;
  }
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.write === "function" &&
    typeof ClipboardItem !== "undefined"
  );
}

export async function copyImageAttachment(item: ImageAttachmentActionItem): Promise<void> {
  const desktopCopyImage =
    typeof window !== "undefined" ? window.desktopBridge?.copyImage : undefined;
  if (desktopCopyImage) {
    const pngBlob = await fetchImageAttachmentBlob(item).then(rasterizeImageBlobToPng);
    await desktopCopyImage(new Uint8Array(await pngBlob.arrayBuffer()));
    return;
  }

  if (!canCopyImageToClipboard()) {
    throw imageActionError("Image copying is not supported in this environment.");
  }

  // Pass the promise directly to ClipboardItem so browsers that require the
  // write call to remain inside the user gesture do not lose activation while
  // the authenticated attachment is fetched and, when needed, rasterized.
  const preparation = fetchImageAttachmentBlob(item).then(rasterizeImageBlobToPng);
  const observedPreparation = preparation.then(
    (blob) => ({ ok: true as const, blob }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const clipboardBlob = observedPreparation.then((result) => {
    if (!result.ok) {
      throw result.error;
    }
    return result.blob;
  });
  // Clipboard implementations may reject before consuming their promised
  // data. Observe that rejection immediately so a later fetch/decode failure
  // cannot become an unhandled rejection.
  void clipboardBlob.catch(() => undefined);
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": clipboardBlob })]);
  } catch (clipboardError) {
    const prepared = await observedPreparation;
    if (!prepared.ok) {
      throw prepared.error;
    }
    throw clipboardError;
  }
}

export function sanitizeImageDownloadFilename(name: string): string {
  return sanitizeDownloadFilename(name, "image");
}

export async function downloadImageAttachment(item: ImageAttachmentActionItem): Promise<void> {
  const blob = await fetchImageAttachmentBlob(item);
  const filename = sanitizeImageDownloadFilename(item.name);
  const desktopDownloadImage =
    typeof window !== "undefined" ? window.desktopBridge?.downloadImage : undefined;
  if (desktopDownloadImage) {
    await desktopDownloadImage(new Uint8Array(await blob.arrayBuffer()), filename);
    return;
  }

  if (typeof document === "undefined" || !document.body) {
    throw imageActionError("Image downloading is not supported in this environment.");
  }

  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.style.display = "none";
    document.body.append(anchor);
    try {
      anchor.click();
    } finally {
      anchor.remove();
    }
  } finally {
    // Revoking synchronously can cancel a download in some browsers.
    globalThis.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }
}
