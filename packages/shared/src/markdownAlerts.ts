/**
 * GitHub-flavored alert callouts: a top-level blockquote whose first line is
 * `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]`. Shared so
 * the chat renderer and thread-find text extraction agree on what the marker is.
 */
export const GFM_ALERT_TYPES = ["note", "tip", "important", "warning", "caution"] as const;

export type GfmAlertType = (typeof GFM_ALERT_TYPES)[number];

const GFM_ALERT_MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(\r?\n|$)/i;

/** The alert type and the marker's length (including its line break) at the start of `text`. */
export function matchGfmAlertMarker(
  text: string,
): { readonly type: GfmAlertType; readonly length: number; readonly endsLine: boolean } | null {
  const match = GFM_ALERT_MARKER.exec(text);
  if (!match) return null;
  return {
    type: match[1]!.toLowerCase() as GfmAlertType,
    length: match[0].length,
    endsLine: match[2] !== "",
  };
}

export function isGfmAlertType(value: unknown): value is GfmAlertType {
  return typeof value === "string" && (GFM_ALERT_TYPES as readonly string[]).includes(value);
}

/** The structural subset of an mdast node this module reads. */
export interface GfmAlertNode {
  readonly type: string;
  readonly value?: string;
  readonly children?: readonly GfmAlertNode[];
}

/**
 * The alert type and the blockquote's children with the marker removed, or
 * `null` when the blockquote is not an alert. The marker must sit alone on the
 * first line of the first paragraph; a marker-only paragraph is dropped.
 */
export function splitGfmAlert<N extends GfmAlertNode>(blockquote: {
  readonly children: readonly N[];
}): { readonly type: GfmAlertType; readonly children: N[] } | null {
  const [first, ...rest] = blockquote.children;
  if (first?.type !== "paragraph" || !first.children) return null;
  const [lead, ...inline] = first.children;
  if (lead?.type !== "text" || lead.value === undefined) return null;
  const marker = matchGfmAlertMarker(lead.value);
  if (!marker) return null;
  const remainder = lead.value.slice(marker.length);
  let paragraph: GfmAlertNode[] = remainder ? [{ ...lead, value: remainder }, ...inline] : inline;
  if (!marker.endsLine && !remainder) {
    // `[!NOTE] **bold**` keeps the marker on a line with other content.
    if (paragraph.length > 0 && paragraph[0]!.type !== "break") return null;
    paragraph = paragraph.slice(1);
  }
  const children =
    paragraph.length > 0
      ? [{ ...first, children: paragraph } as unknown as N, ...rest]
      : (rest as N[]);
  // A marker with no body stays a plain blockquote, as on GitHub.
  if (children.length === 0) return null;
  return { type: marker.type, children };
}
