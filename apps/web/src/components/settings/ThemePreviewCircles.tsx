import type { ThemePalette, ThemeVariant } from "../../themePalette";

export function ThemePreviewCircles({
  palette,
  variant,
}: {
  readonly palette: ThemePalette;
  readonly variant: ThemeVariant;
}) {
  const colors = palette[variant];
  return (
    <span className="flex shrink-0 -space-x-1" aria-hidden="true">
      {[colors.background, colors.primary, colors.accent, colors.foreground].map((color, index) => (
        <span
          key={`${color}:${index}`}
          className="size-5 rounded-full border border-black/15 shadow-sm"
          style={{ backgroundColor: color }}
        />
      ))}
    </span>
  );
}
