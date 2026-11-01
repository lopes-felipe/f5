import { HTML_RENDER_COLUMN_WIDTH, HTML_RENDER_MAX_FIT_HEIGHT } from "@t3tools/shared/htmlRender";
import { THEME_TOKEN_NAMES } from "@t3tools/shared/themeTokens";

/**
 * Guidance for HTML pages. It lives in the tool descriptions, so a provider
 * sees it only when the HTML tools are attached.
 */
const tokens = new Set<string>(THEME_TOKEN_NAMES);
const pairs = THEME_TOKEN_NAMES.flatMap((name) =>
  name === "background"
    ? ["--background/--foreground"]
    : !name.endsWith("-foreground") && name !== "foreground" && tokens.has(`${name}-foreground`)
      ? [`--${name}/--${name}-foreground`]
      : [],
);
const singles = THEME_TOKEN_NAMES.filter(
  (name) =>
    name !== "background" &&
    name !== "foreground" &&
    !name.endsWith("-foreground") &&
    !tokens.has(`${name}-foreground`),
).map((name) => `--${name}`);

export const HTML_RENDER_THEME_GUIDE = `Style with the reader's theme variables, all hex colors that follow their palette and light/dark mode: ${pairs.join(", ")} (surface and its text), ${singles.join(", ")}; --chart-1 to --chart-6 for data series in a fixed order, with labels in --foreground; --radius for corners; --font-sans and --font-mono for text.`;

export const HTML_RENDER_LAYOUT_GUIDE = `The frame follows the reader's chat width: about ${HTML_RENDER_COLUMN_WIDTH}px by default, wider on large screens and about 360px on phones, so use fluid widths. Leave html, body and the outermost element without a background, card or side padding; F5 adds an 8px gutter. A box with its own background gets 16px of padding and var(--radius) corners. Give charts fixed pixel heights. Content sets the page height: no vh units and no height:100% on html or body. Remote content loads only when the reader allows it.`;

export const HTML_RENDER_IMAGE_GUIDE =
  "Local images use absolute paths inside the project, worktree or attachments; F5 inlines them. JavaScript runs in a sandboxed frame.";

export const HTML_RENDER_DESCRIPTION = [
  `Show a finished HTML page (chart, diagram, mockup) inline in this thread, above your final reply. When an answer shows a trend or comparison in data, prefer showing it as a chart with this tool, unless the user asked for text only or for an exportable image. Check it with html_preview first; if preview is Unavailable, publish anyway; if a page is rejected, fix it and retry. Do not announce or restate the page. The frame fits the page height up to ${HTML_RENDER_MAX_FIT_HEIGHT}px.`,
  HTML_RENDER_IMAGE_GUIDE,
  HTML_RENDER_LAYOUT_GUIDE,
  HTML_RENDER_THEME_GUIDE,
].join("\n\n");

export const HTML_PREVIEW_DESCRIPTION =
  "Check an HTML page before html_render. Renders in the connected F5 desktop with the reader's theme and returns a PNG, contentHeight, console output, and any missingImages or note. Unavailable without a connected desktop; html_render still works.";

/** For instruction channels outside the tool catalog, such as Pi's system prompt. */
export const HTML_RENDER_CHART_GUIDANCE =
  "When an answer shows a trend or comparison in data, prefer showing it as a chart with html_render, unless the user asked for text only or for an exportable image.";
