import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  LoaderCircleIcon,
  XIcon,
} from "lucide-react";
import { useEffect, type MouseEvent as ReactMouseEvent } from "react";

import { Button } from "../ui/button";
import type { ImageAttachmentActionItem } from "./imageAttachmentActions";
import type { ImageAttachmentAction } from "./useImageAttachmentActions";

export interface ExpandedImageItem extends ImageAttachmentActionItem {
  previewSrc: string;
}

export interface ExpandedImagePreview {
  images: ExpandedImageItem[];
  index: number;
}

interface ExpandedImageSource {
  previewUrl?: string;
  sourceUrl?: string;
}

export function refreshExpandedImageActionSources(
  preview: ExpandedImagePreview,
  sources: ReadonlyArray<ExpandedImageSource>,
): ExpandedImagePreview {
  const sourceUrlByPreviewUrl = new Map<string, string>();
  for (const source of sources) {
    if (source.previewUrl && source.sourceUrl) {
      sourceUrlByPreviewUrl.set(source.previewUrl, source.sourceUrl);
    }
  }

  let changed = false;
  const images = preview.images.map((image) => {
    const sourceUrl = sourceUrlByPreviewUrl.get(image.previewSrc);
    if (!sourceUrl || sourceUrl === image.src) {
      return image;
    }
    changed = true;
    return { ...image, src: sourceUrl };
  });
  return changed ? { ...preview, images } : preview;
}

export function buildExpandedImagePreview(
  images: ReadonlyArray<{
    id: string;
    name: string;
    mimeType: string;
    previewUrl?: string;
    sourceUrl?: string;
    sourceBlob?: Blob;
    file?: Blob;
  }>,
  selectedImageId: string,
): ExpandedImagePreview | null {
  const previewableImages = images.flatMap((image) =>
    image.previewUrl
      ? [
          {
            id: image.id,
            src: image.sourceUrl ?? image.previewUrl,
            previewSrc: image.previewUrl,
            name: image.name,
            mimeType: image.mimeType,
            sourceBlob: image.sourceBlob ?? image.file,
          },
        ]
      : [],
  );
  if (previewableImages.length === 0) {
    return null;
  }
  const selectedIndex = previewableImages.findIndex((image) => image.id === selectedImageId);
  if (selectedIndex < 0) {
    return null;
  }
  return {
    images: previewableImages.map((image) => ({
      src: image.src,
      previewSrc: image.previewSrc,
      name: image.name,
      mimeType: image.mimeType,
      ...(image.sourceBlob ? { sourceBlob: image.sourceBlob } : {}),
    })),
    index: selectedIndex,
  };
}

export function ExpandedImageDialog({
  preview,
  canCopyImage,
  usesCustomImageContextMenu,
  pendingAction,
  onClose,
  onNavigate,
  onAction,
  onActionMenu,
}: {
  preview: ExpandedImagePreview;
  canCopyImage: boolean;
  usesCustomImageContextMenu: boolean;
  pendingAction: ImageAttachmentAction | null;
  onClose: () => void;
  onNavigate: (direction: -1 | 1) => void;
  onAction: (action: ImageAttachmentAction, item: ExpandedImageItem) => void;
  onActionMenu: (item: ExpandedImageItem, position: { x: number; y: number }) => void;
}) {
  const item = preview.images[preview.index];

  useEffect(() => {
    if (!item) {
      return;
    }

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (
        !event.repeat &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "c" &&
        canCopyImage &&
        !pendingAction
      ) {
        event.preventDefault();
        event.stopPropagation();
        onAction("copy", item);
        return;
      }
      if (preview.images.length <= 1) {
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        onNavigate(-1);
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        event.stopPropagation();
        onNavigate(1);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canCopyImage, item, onAction, onClose, onNavigate, pendingAction, preview.images.length]);

  if (!item) {
    return null;
  }

  const handleContextMenu = (event: ReactMouseEvent) => {
    if (!usesCustomImageContextMenu) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    onActionMenu(item, { x: event.clientX, y: event.clientY });
  };
  const actionsDisabled = pendingAction !== null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 py-6 [-webkit-app-region:no-drag]"
      role="dialog"
      aria-modal="true"
      aria-label="Expanded image preview"
    >
      <button
        type="button"
        className="absolute inset-0 z-0 cursor-zoom-out"
        aria-label="Close image preview"
        onClick={onClose}
      />
      {preview.images.length > 1 && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute left-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:left-6"
          aria-label="Previous image"
          onClick={() => onNavigate(-1)}
        >
          <ChevronLeftIcon className="size-5" />
        </Button>
      )}
      <div className="relative isolate z-10 max-h-[92vh] max-w-[92vw]">
        <div className="absolute right-2 top-2 z-20 flex items-center gap-1 rounded-md bg-black/45 p-1 shadow-sm backdrop-blur-sm">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="text-white/90 hover:bg-white/15 hover:text-white"
            disabled={!canCopyImage || actionsDisabled}
            onClick={() => onAction("copy", item)}
            aria-label="Copy image"
            title={
              canCopyImage
                ? "Copy image as PNG (Cmd/Ctrl+C)"
                : "Image copying is unavailable in this environment"
            }
          >
            {pendingAction === "copy" ? (
              <LoaderCircleIcon className="animate-spin" />
            ) : (
              <CopyIcon />
            )}
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="text-white/90 hover:bg-white/15 hover:text-white"
            disabled={actionsDisabled}
            onClick={() => onAction("download", item)}
            aria-label="Download image"
            title="Download image"
          >
            {pendingAction === "download" ? (
              <LoaderCircleIcon className="animate-spin" />
            ) : (
              <DownloadIcon />
            )}
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="text-white/90 hover:bg-white/15 hover:text-white"
            onClick={onClose}
            aria-label="Close image preview"
            title="Close image preview"
          >
            <XIcon />
          </Button>
        </div>
        <img
          src={item.previewSrc}
          alt={item.name}
          className="max-h-[86vh] max-w-[92vw] select-none rounded-lg border border-border/70 bg-background object-contain shadow-2xl"
          draggable={false}
          onContextMenu={handleContextMenu}
        />
        <p className="mt-2 max-w-[92vw] truncate text-center text-xs text-muted-foreground/80">
          {item.name}
          {preview.images.length > 1 ? ` (${preview.index + 1}/${preview.images.length})` : ""}
        </p>
      </div>
      {preview.images.length > 1 && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute right-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:right-6"
          aria-label="Next image"
          onClick={() => onNavigate(1)}
        >
          <ChevronRightIcon className="size-5" />
        </Button>
      )}
    </div>
  );
}
