import { HTML_RENDER_COLUMN_WIDTH, HTML_RENDER_MAX_FIT_HEIGHT } from "@t3tools/shared/htmlRender";

export const HTML_RENDER_THEME_GUIDE =
  "Use theme CSS variables: --background/--foreground, --card, --popover, --muted, --secondary, --primary, --accent, --destructive, --warning, --success, --info (matching -foreground for text); --border, --ring, --chart-1 to --chart-6, --radius, --font-sans, --font-mono.";

export const HTML_RENDER_LAYOUT_GUIDE =
  "Fluid reply width (default " +
  HTML_RENDER_COLUMN_WIDTH +
  "px, about 360px on phones). Leave html, body and the outermost element without a background, card or side padding; F5 adds an 8px gutter. Colored boxes: 16px of padding and var(--radius) corners. Charts: fixed pixel heights. Content sets height; no vh units or height:100% on html/body. Remote content needs reader permission.";

export const HTML_RENDER_IMAGE_GUIDE =
  "Pass inline html OR an absolute .html path (full-access only; snapshotted). Local images must be absolute project/worktree/attachment paths; F5 inlines them. JavaScript is sandboxed.";

export const HTML_RENDER_CHART_GUIDANCE =
  "Show data trends and comparisons with html_render unless text only or an exportable image was requested.";

export const HTML_RENDER_DESCRIPTION = [
  "Show finished HTML inline above your reply (height cap " +
    HTML_RENDER_MAX_FIT_HEIGHT +
    "px). Preview first; publish if Unavailable, fix and retry if rejected. Do not restate the page.",
  HTML_RENDER_CHART_GUIDANCE,
  HTML_RENDER_IMAGE_GUIDE,
  HTML_RENDER_LAYOUT_GUIDE,
  HTML_RENDER_THEME_GUIDE,
].join("\n\n");

export const HTML_PREVIEW_DESCRIPTION =
  "Check HTML before html_render. Connected desktop returns themed PNG, contentHeight, console output, missingImages and note. Unavailable without desktop; html_render still works.";
