import { converter, formatHex, parse, wcagContrast, type Color } from "culori";
import { HTML_RENDER_CHART_COLORS, type HtmlRenderTheme } from "@t3tools/shared/htmlRender";
import { THEME_TOKEN_NAMES } from "@t3tools/shared/themeTokens";
import { MIN_DECORATIVE_CONTRAST, type ThemeTokens, type ThemeVariant } from "../themePalette";

/** F5's `--radius` (0.75rem) at the default 16px root size. */
export const HTML_RENDER_RADIUS = "12px";
const FALLBACK_BACKGROUND = { light: "#ffffff", dark: "#18181b" } as const;
const toRgb = converter("rgb");
const toOklch = converter("oklch");

/** Opaque `#rrggbb`; a translucent color is composited over `background` first. */
function opaqueHex(value: string, background: Color): string | null {
  const color = toRgb(parse(value));
  if (!color) return null;
  const alpha = color.alpha ?? 1;
  if (alpha >= 1) return formatHex(color);
  const under = toRgb(background)!;
  return formatHex({
    mode: "rgb",
    r: color.r * alpha + under.r * (1 - alpha),
    g: color.g * alpha + under.g * (1 - alpha),
    b: color.b * alpha + under.b * (1 - alpha),
  });
}

/**
 * A chart color that reaches 3:1 against the background, moving only its
 * OKLCH lightness toward the end with more contrast, so hue order holds.
 */
function legibleChartColor(value: string, background: string): string {
  if (wcagContrast(value, background) >= MIN_DECORATIVE_CONTRAST) return value;
  const color = toOklch(parse(value))!;
  const at = (lightness: number) => formatHex({ ...color, l: lightness });
  const target = wcagContrast(at(1), background) > wcagContrast(at(0), background) ? 1 : 0;
  if (wcagContrast(at(target), background) < MIN_DECORATIVE_CONTRAST) return at(target);
  let near = color.l;
  let far = target;
  for (let step = 0; step < 12; step += 1) {
    const middle = (near + far) / 2;
    if (wcagContrast(at(middle), background) >= MIN_DECORATIVE_CONTRAST) far = middle;
    else near = middle;
  }
  return at(far);
}

/**
 * The CSS variables an HTML render or MCP App receives. Every color is hex, so
 * pages can hand them to chart and canvas libraries that do not read `oklch()`.
 */
export function htmlRenderThemeFromPalette(
  tokens: ThemeTokens,
  appearance: ThemeVariant,
  fonts: { readonly sans: string; readonly mono: string },
): HtmlRenderTheme {
  const background =
    toRgb(parse(tokens.background)) ?? toRgb(parse(FALLBACK_BACKGROUND[appearance]))!;
  const opaqueBackground = formatHex({ ...background, alpha: 1 });
  const variables: Record<string, string> = {};
  for (const name of THEME_TOKEN_NAMES) {
    const hex = name === "background" ? opaqueBackground : opaqueHex(tokens[name], background);
    if (hex) variables[`--${name}`] = hex;
  }
  const chart = [
    variables["--primary"] ?? HTML_RENDER_CHART_COLORS[appearance][0],
    ...HTML_RENDER_CHART_COLORS[appearance],
  ];
  chart.forEach((color, index) => {
    variables[`--chart-${index + 1}`] = legibleChartColor(color, opaqueBackground);
  });
  variables["--radius"] = HTML_RENDER_RADIUS;
  variables["--font-sans"] = fonts.sans;
  variables["--font-mono"] = fonts.mono;
  return { appearance, variables };
}
