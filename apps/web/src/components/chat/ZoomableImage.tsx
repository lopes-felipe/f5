import { MinusIcon, PlusIcon, RotateCcwIcon } from "lucide-react";
import { useRef, useState, type MouseEventHandler } from "react";
import { Button } from "../ui/button";

/** The unscaled image stays fitted; panning never moves it entirely out of view. */
export function ZoomableImage({
  src,
  name,
  onContextMenu,
}: {
  src: string;
  name: string;
  onContextMenu: MouseEventHandler<HTMLImageElement>;
}) {
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const imageRef = useRef<HTMLImageElement>(null);
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    originX: number;
    originY: number;
  } | null>(null);
  const changeZoom = (next: number) => {
    setZoom(Math.min(8, Math.max(1, next)));
    setOffset({ x: 0, y: 0 });
  };
  return (
    <>
      <div
        className="overflow-hidden rounded-lg border border-border/70 bg-white shadow-2xl"
        style={{ touchAction: "none" }}
      >
        <img
          ref={imageRef}
          src={src}
          alt={name}
          draggable={false}
          className="max-h-[80vh] max-w-[92vw] select-none object-contain"
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
            cursor: zoom > 1 ? "grab" : "zoom-in",
          }}
          onContextMenu={onContextMenu}
          onDoubleClick={() => changeZoom(zoom === 1 ? 2 : 1)}
          onPointerDown={(event) => {
            if (event.button !== 0 || zoom === 1) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = {
              id: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              originX: offset.x,
              originY: offset.y,
            };
          }}
          onPointerMove={(event) => {
            const start = drag.current;
            if (!start || start.id !== event.pointerId) return;
            const image = imageRef.current;
            if (!image) return;
            const maxX = (image.clientWidth * (zoom - 1)) / 2;
            const maxY = (image.clientHeight * (zoom - 1)) / 2;
            setOffset({
              x: Math.max(-maxX, Math.min(maxX, start.originX + event.clientX - start.x)),
              y: Math.max(-maxY, Math.min(maxY, start.originY + event.clientY - start.y)),
            });
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onLostPointerCapture={() => {
            drag.current = null;
          }}
        />
      </div>
      <div className="mt-2 flex items-center justify-center gap-2 text-white">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Zoom out"
          disabled={zoom <= 1}
          onClick={() => changeZoom(zoom / 1.5)}
        >
          <MinusIcon />
        </Button>
        <output aria-label="Image zoom" className="min-w-10 text-center text-xs">
          {Math.round(zoom * 100)}%
        </output>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Zoom in"
          disabled={zoom >= 8}
          onClick={() => changeZoom(zoom * 1.5)}
        >
          <PlusIcon />
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="Fit image" onClick={() => changeZoom(1)}>
          <RotateCcwIcon />
        </Button>
      </div>
    </>
  );
}
