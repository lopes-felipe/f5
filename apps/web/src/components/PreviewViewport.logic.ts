export type PreviewViewportPresetId = "responsive" | "phone" | "tablet" | "desktop";

export interface PreviewViewportDimensions {
  readonly width: number;
  readonly height: number;
}

export const PREVIEW_VIEWPORT_PRESETS: ReadonlyArray<{
  readonly id: PreviewViewportPresetId;
  readonly label: string;
  readonly dimensions: PreviewViewportDimensions | null;
}> = [
  { id: "responsive", label: "Responsive", dimensions: null },
  { id: "phone", label: "375 × 812", dimensions: { width: 375, height: 812 } },
  { id: "tablet", label: "768 × 1024", dimensions: { width: 768, height: 1024 } },
  { id: "desktop", label: "1280 × 720", dimensions: { width: 1280, height: 720 } },
];

export function orientPreviewViewport(
  dimensions: PreviewViewportDimensions,
  orientation: "portrait" | "landscape",
): PreviewViewportDimensions {
  const short = Math.min(dimensions.width, dimensions.height);
  const long = Math.max(dimensions.width, dimensions.height);
  return orientation === "portrait"
    ? { width: short, height: long }
    : { width: long, height: short };
}

export function clampPreviewViewport(input: {
  readonly requested: PreviewViewportDimensions;
  readonly bounds: PreviewViewportDimensions;
}): PreviewViewportDimensions {
  const maximumWidth = Math.max(320, Math.floor(input.bounds.width));
  const maximumHeight = Math.max(320, Math.floor(input.bounds.height));
  return {
    width: Math.min(maximumWidth, Math.max(320, Math.floor(input.requested.width))),
    height: Math.min(maximumHeight, Math.max(320, Math.floor(input.requested.height))),
  };
}

export function resizePreviewViewport(input: {
  readonly initial: PreviewViewportDimensions;
  readonly delta: PreviewViewportDimensions;
  readonly linked: boolean;
  readonly bounds: PreviewViewportDimensions;
}): PreviewViewportDimensions {
  const requestedWidth = input.initial.width + input.delta.width;
  const aspectRatio = input.initial.width / input.initial.height;
  return clampPreviewViewport({
    requested: {
      width: requestedWidth,
      height: input.linked
        ? requestedWidth / aspectRatio
        : input.initial.height + input.delta.height,
    },
    bounds: input.bounds,
  });
}

export function nearestPreviewViewportPreset(
  dimensions: PreviewViewportDimensions,
): PreviewViewportPresetId | null {
  for (const preset of PREVIEW_VIEWPORT_PRESETS) {
    if (
      preset.dimensions &&
      preset.dimensions.width === dimensions.width &&
      preset.dimensions.height === dimensions.height
    ) {
      return preset.id;
    }
  }
  return null;
}
