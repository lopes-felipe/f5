import { useMemo } from "react";
import type { HtmlRenderTheme } from "@t3tools/shared/htmlRender";
import { useTheme } from "./useTheme";

/**
 * An opaque CSS color as `#rrggbb`, or null for a translucent or invalid one.
 * Pages often hand theme colors to chart and canvas libraries that read hex
 * but not `oklch()`, `color-mix()` or system colors, so the browser rasterizes
 * the color and the exact sRGB pixel is read back.
 */
export function cssColorToHex(value: string): string | null {
  if (!value || !CSS.supports("color", value)) return null;
  const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
  if (alpha !== 255) return null;
  return `#${[red, green, blue].map((channel) => channel!.toString(16).padStart(2, "0")).join("")}`;
}

export function useHtmlRenderTheme(): HtmlRenderTheme {
  const { resolvedTheme } = useTheme();
  return useMemo(() => {
    const style = getComputedStyle(document.documentElement);
    const variables = Object.fromEntries(
      [
        "--background",
        "--foreground",
        "--muted",
        "--muted-foreground",
        "--primary",
        "--primary-foreground",
        "--border",
        "--card",
        "--card-foreground",
      ].map((key) => {
        const value = style.getPropertyValue(key).trim();
        return [key, cssColorToHex(value) ?? value];
      }),
    );
    return { appearance: resolvedTheme, variables };
  }, [resolvedTheme]);
}
