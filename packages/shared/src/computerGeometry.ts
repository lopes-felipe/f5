import type { ComputerDisplay } from "@t3tools/contracts";

export function computerModelSize(pixelSize: { readonly width: number; readonly height: number }): {
  width: number;
  height: number;
} {
  const { width, height } = pixelSize;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1)
    throw new RangeError("Invalid display size");
  const scale = Math.min(
    1,
    1456 / Math.max(width, height),
    Math.sqrt(1_150_000 / (width * height)),
  );
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}
/** Coordinates use the pixel centre; native origins may be negative. */
export function computerModelToNative(
  display: ComputerDisplay,
  x: number,
  y: number,
  platform: "darwin" | "win32",
): { x: number; y: number } {
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= display.modelSize.width ||
    y >= display.modelSize.height
  )
    throw new RangeError("Coordinates outside display model space");
  const point = {
    x: display.nativeBounds.x + ((x + 0.5) * display.nativeBounds.width) / display.modelSize.width,
    y:
      display.nativeBounds.y + ((y + 0.5) * display.nativeBounds.height) / display.modelSize.height,
  };
  // Rounding a pixel centre on the final column must not hit the adjacent display.
  return platform === "win32"
    ? {
        x: Math.min(display.nativeBounds.x + display.nativeBounds.width - 1, Math.round(point.x)),
        y: Math.min(display.nativeBounds.y + display.nativeBounds.height - 1, Math.round(point.y)),
      }
    : point;
}
export function computerGeometryGeneration(
  display: Omit<ComputerDisplay, "geometryGeneration" | "modelSize" | "primary">,
): string {
  // Full canonical geometry is collision-free, includes scale through pixel/native ratios.
  return JSON.stringify([
    display.displayId,
    display.nativeBounds.x,
    display.nativeBounds.y,
    display.nativeBounds.width,
    display.nativeBounds.height,
    display.pixelSize.width,
    display.pixelSize.height,
    display.rotation,
  ]);
}
