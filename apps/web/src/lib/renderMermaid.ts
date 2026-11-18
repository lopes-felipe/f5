import { LRUCache } from "./lruCache";

const MAX_SOURCE_CHARS = 50_000;
const MAX_PENDING_RENDERS = 8;
const cache = new LRUCache<string>(64, 4 * 1024 * 1024);
let queue: Promise<unknown> = Promise.resolve();
let pending = 0;
let nextId = 0;

/** Percentage-sized SVGs can collapse inside an auto-sized image button. */
function withIntrinsicDimensions(svg: string): string {
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = parsed.documentElement;
  if (root.localName !== "svg" || parsed.querySelector("parsererror")) {
    throw new Error("Unable to read the rendered diagram.");
  }
  const viewBox = root.getAttribute("viewBox");
  if (viewBox === null) return svg;
  const dimensions = viewBox
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (
    dimensions.length !== 4 ||
    !dimensions.every(Number.isFinite) ||
    dimensions[2]! <= 0 ||
    dimensions[3]! <= 0
  ) {
    throw new Error("Rendered diagram has invalid dimensions.");
  }
  root.setAttribute("width", String(dimensions[2]));
  root.setAttribute("height", String(dimensions[3]));
  return new XMLSerializer().serializeToString(root);
}

/** A previously rendered SVG, so a remounted diagram can show it without a loading state. */
export function peekRenderedMermaid(source: string, theme: "light" | "dark"): string | null {
  return cache.get(`${theme}\u0000${source}`);
}

/** Mermaid's configuration is global, so theme changes and rendering share a queue. */
export async function renderMermaid(
  source: string,
  theme: "light" | "dark",
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  if (source.length > MAX_SOURCE_CHARS)
    throw new Error("Diagram is too large. View its source instead.");
  const key = `${theme}\u0000${source}`;
  const cached = cache.get(key);
  if (cached !== null) return cached;
  if (pending >= MAX_PENDING_RENDERS)
    throw new Error("Diagram renderer is busy. Retry in a moment.");
  pending += 1;
  const job = queue.then(async () => {
    signal.throwIfAborted();
    // This dependency and its individual diagram grammars stay outside the initial bundle.
    const { default: mermaid } = await import("mermaid");
    signal.throwIfAborted();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      maxTextSize: MAX_SOURCE_CHARS,
      maxEdges: 500,
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      secure: [
        "secure",
        "securityLevel",
        "startOnLoad",
        "suppressErrorRendering",
        "maxTextSize",
        "maxEdges",
        "htmlLabels",
        "flowchart",
        "themeCSS",
        "themeVariables",
        "fontFamily",
        "theme",
      ],
      theme: theme === "dark" ? "dark" : "default",
      fontFamily: "Inter, system-ui, sans-serif",
    });
    const id = `f5-mermaid-${nextId++}`;
    const host = document.createElement("div");
    host.style.position = "absolute";
    host.style.visibility = "hidden";
    host.style.pointerEvents = "none";
    host.setAttribute("aria-hidden", "true");
    document.body.appendChild(host);
    try {
      const { svg } = await mermaid.render(id, source, host);
      signal.throwIfAborted();
      if (svg.length > 2 * 1024 * 1024) throw new Error("Rendered diagram is too large.");
      // Consumers display this as an image, never insert it into the application DOM.
      const sizedSvg = withIntrinsicDimensions(svg);
      if (sizedSvg.length > 2 * 1024 * 1024) throw new Error("Rendered diagram is too large.");
      cache.set(key, sizedSvg, (key.length + sizedSvg.length) * 2);
      return sizedSvg;
    } finally {
      host.remove();
    }
  });
  queue = job.then(
    () => undefined,
    () => undefined,
  );
  try {
    return await job;
  } finally {
    pending -= 1;
  }
}
