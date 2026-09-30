import { useEffect, useRef } from "react";
import { Dialog, DialogPopup, DialogTitle } from "./ui/dialog";
import { ZoomableImage } from "./chat/ZoomableImage";
export interface AssetGalleryState {
  images: Array<{ src: string; name: string }>;
  index: number;
}
export function AssetImageGallery({
  gallery,
  onChange,
  onClose,
}: {
  gallery: AssetGalleryState;
  onChange: (gallery: AssetGalleryState) => void;
  onClose: () => void;
}) {
  const navigate = (offset: number) =>
    onChange({
      ...gallery,
      index: (gallery.index + offset + gallery.images.length) % gallery.images.length,
    });
  // Return focus to the opener on close; otherwise it is left on the unmounted
  // dialog and the composer that owned the opener treats that as a blur.
  const openerRef = useRef<Element | null>(null);
  useEffect(() => {
    openerRef.current = document.activeElement;
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        navigate(event.key === "ArrowLeft" ? -1 : 1);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  const current = gallery.images[gallery.index];
  if (!current) return null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup
        showCloseButton={false}
        className="h-[85vh] max-w-[95vw] items-center justify-center bg-black/90 p-8"
      >
        <DialogTitle className="sr-only">Image gallery</DialogTitle>
        <button autoFocus onClick={onClose} className="absolute right-4 top-4 text-white">
          Close
        </button>
        {gallery.images.length > 1 && (
          <button
            aria-label="Previous image"
            onClick={() => navigate(-1)}
            className="absolute left-4 text-white"
          >
            ‹
          </button>
        )}
        <ZoomableImage
          key={current.src}
          src={current.src}
          name={current.name}
          onContextMenu={() => {}}
        />
        {gallery.images.length > 1 && (
          <button
            aria-label="Next image"
            onClick={() => navigate(1)}
            className="absolute right-4 text-white"
          >
            ›
          </button>
        )}
      </DialogPopup>
    </Dialog>
  );
}
