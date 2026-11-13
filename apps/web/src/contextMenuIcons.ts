const SVG_NS = "http://www.w3.org/2000/svg";

// Inline Lucide-style icon paths (stroke-based, viewBox 0 0 24 24, strokeWidth 2).
export const ICON_PATHS: Record<
  string,
  ReadonlyArray<{ tag: string; attrs: Record<string, string> }>
> = {
  archive: [
    { tag: "rect", attrs: { width: "20", height: "5", x: "2", y: "3", rx: "1" } },
    { tag: "path", attrs: { d: "M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" } },
    { tag: "path", attrs: { d: "M10 12h4" } },
  ],
  "chevron-right": [{ tag: "path", attrs: { d: "m9 19 7-7-7-7" } }],
  "circle-check": [
    { tag: "circle", attrs: { cx: "12", cy: "12", r: "10" } },
    { tag: "path", attrs: { d: "m9 12 2 2 4-4" } },
  ],
  clock: [
    { tag: "path", attrs: { d: "M12 6v6l4 2" } },
    { tag: "circle", attrs: { cx: "12", cy: "12", r: "10" } },
  ],
  pencil: [
    {
      tag: "path",
      attrs: {
        d: "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z",
      },
    },
    { tag: "path", attrs: { d: "m15 5 4 4" } },
  ],
  copy: [
    { tag: "rect", attrs: { width: "14", height: "14", x: "8", y: "8", rx: "2", ry: "2" } },
    { tag: "path", attrs: { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" } },
  ],
  folder: [
    {
      tag: "path",
      attrs: {
        d: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
      },
    },
  ],
  "git-branch": [
    { tag: "line", attrs: { x1: "6", x2: "6", y1: "3", y2: "15" } },
    { tag: "circle", attrs: { cx: "18", cy: "6", r: "3" } },
    { tag: "circle", attrs: { cx: "6", cy: "18", r: "3" } },
    { tag: "path", attrs: { d: "M18 9a9 9 0 0 1-9 9" } },
  ],
  hash: [
    { tag: "line", attrs: { x1: "4", x2: "20", y1: "9", y2: "9" } },
    { tag: "line", attrs: { x1: "4", x2: "20", y1: "15", y2: "15" } },
    { tag: "line", attrs: { x1: "10", x2: "8", y1: "3", y2: "21" } },
    { tag: "line", attrs: { x1: "16", x2: "14", y1: "3", y2: "21" } },
  ],
  "mail-open": [
    {
      tag: "path",
      attrs: {
        d: "M21.2 8.4c.5.38.8.97.8 1.6v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10a2 2 0 0 1 .8-1.6l8-6a2 2 0 0 1 2.4 0l8 6Z",
      },
    },
    { tag: "path", attrs: { d: "m22 10-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 10" } },
  ],
  "message-square-plus": [
    {
      tag: "path",
      attrs: {
        d: "M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z",
      },
    },
    { tag: "path", attrs: { d: "M12 8v6" } },
    { tag: "path", attrs: { d: "M9 11h6" } },
  ],
  pin: [
    { tag: "path", attrs: { d: "M12 17v5" } },
    {
      tag: "path",
      attrs: {
        d: "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z",
      },
    },
  ],
  "pin-off": [
    { tag: "path", attrs: { d: "M12 17v5" } },
    { tag: "path", attrs: { d: "M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89" } },
    { tag: "path", attrs: { d: "m2 2 20 20" } },
    {
      tag: "path",
      attrs: {
        d: "M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11",
      },
    },
  ],
  "refresh-cw": [
    { tag: "path", attrs: { d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" } },
    { tag: "path", attrs: { d: "M21 3v5h-5" } },
    { tag: "path", attrs: { d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" } },
    { tag: "path", attrs: { d: "M8 16H3v5" } },
  ],
  "folder-tree": [
    {
      tag: "path",
      attrs: {
        d: "M20 10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 15 3h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z",
      },
    },
    {
      tag: "path",
      attrs: {
        d: "M20 21a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-2.9a1 1 0 0 1-.88-.55l-.42-.85a1 1 0 0 0-.92-.6H13a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z",
      },
    },
    { tag: "path", attrs: { d: "M3 5a2 2 0 0 0 2 2h3" } },
    { tag: "path", attrs: { d: "M3 3v13a2 2 0 0 0 2 2h3" } },
  ],
  trash: [
    { tag: "path", attrs: { d: "M3 6h18" } },
    { tag: "path", attrs: { d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" } },
    { tag: "path", attrs: { d: "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" } },
    { tag: "line", attrs: { x1: "10", x2: "10", y1: "11", y2: "17" } },
    { tag: "line", attrs: { x1: "14", x2: "14", y1: "11", y2: "17" } },
  ],
};

export function createIconElement(
  name: string,
  tone: "neutral" | "destructive",
): SVGSVGElement | null {
  const paths = ICON_PATHS[name];
  if (!paths || typeof document.createElementNS !== "function") {
    return null;
  }
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("xmlns", SVG_NS);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute(
    "class",
    tone === "destructive"
      ? "size-4.5 shrink-0 sm:size-4"
      : "size-4.5 shrink-0 text-muted-foreground sm:size-4",
  );
  for (const node of paths) {
    const child = document.createElementNS(SVG_NS, node.tag);
    for (const [key, value] of Object.entries(node.attrs)) {
      child.setAttribute(key, value);
    }
    svg.appendChild(child);
  }
  return svg;
}
