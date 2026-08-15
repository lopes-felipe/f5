export interface ContextMenuPosition {
  readonly x: number;
  readonly y: number;
}

export function resolveContextMenuPopupPosition(
  position: ContextMenuPosition | null | undefined,
  zoomFactor: number,
): ContextMenuPosition | null {
  if (
    !position ||
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y) ||
    position.x < 0 ||
    position.y < 0
  ) {
    return null;
  }

  const safeZoomFactor = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  return {
    x: Math.floor(position.x * safeZoomFactor),
    y: Math.floor(position.y * safeZoomFactor),
  };
}
