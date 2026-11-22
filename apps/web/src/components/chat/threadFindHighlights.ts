import { findThreadSearchOccurrences } from "@t3tools/shared/threadSearch";
import { observeResize } from "~/lib/observeResize";

const ROW = "[data-timeline-row-id]";
const BODY = "[data-thread-find-text]";
const IGNORE =
  'button,input,textarea,select,script,style,.sr-only,[aria-hidden="true"],[data-thread-find-ignore]';
const BLOCKS = new Set([
  "P",
  "PRE",
  "LI",
  "TD",
  "TH",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "BLOCKQUOTE",
  "BR",
]);
const MATCHES = "f5-thread-find";
const ACTIVE = "f5-thread-find-active";

interface TextBlock {
  readonly nodes: readonly { node: Text; start: number }[];
  readonly offsets: readonly number[];
}

function firstIndex(start: number, end: number, predicate: (index: number) => boolean): number {
  while (start < end) {
    const mid = (start + end) >>> 1;
    if (predicate(mid)) end = mid;
    else start = mid + 1;
  }
  return start;
}

/** Inline syntax spans stay contiguous; distinct Markdown blocks never join. */
function indexText(root: HTMLElement, query: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  let nodes: { node: Text; start: number }[] = [];
  let length = 0;
  const flush = () => {
    if (nodes.length === 0) return;
    const offsets = findThreadSearchOccurrences(nodes.map(({ node }) => node.data).join(""), query);
    if (offsets.length > 0) blocks.push({ nodes, offsets });
    nodes = [];
    length = 0;
  };
  const visit = (node: Node) => {
    if (node instanceof Text) {
      if (node.length > 0) {
        nodes.push({ node, start: length });
        length += node.length;
      }
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.matches(IGNORE)) {
      flush();
      return;
    }
    const block = BLOCKS.has(node.tagName);
    if (block) flush();
    for (const child of node.childNodes) visit(child);
    if (block) flush();
  };
  visit(root);
  flush();
  return blocks;
}

function setMatch(range: Range, block: TextBlock, index: number, length: number): Range {
  const start = block.offsets[index]!;
  const end = start + length;
  const { nodes } = block;
  const first = nodes[firstIndex(0, nodes.length, (i) => nodes[i]!.start > start) - 1]!;
  const last = nodes[firstIndex(0, nodes.length, (i) => nodes[i]!.start >= end) - 1]!;
  range.setStart(first.node, start - first.start);
  range.setEnd(last.node, end - last.start);
  return range;
}

interface Match {
  readonly block: TextBlock;
  readonly index: number;
  readonly range: Range;
}

function findOccurrence(
  blocks: readonly TextBlock[],
  occurrence: number,
  length: number,
): Match | null {
  for (const block of blocks) {
    if (occurrence < block.offsets.length)
      return { block, index: occurrence, range: setMatch(new Range(), block, occurrence, length) };
    occurrence -= block.offsets.length;
  }
  return null;
}

/** @internal Browser tests only. Materializes every range without applying a viewport. */
export function threadFindRangesForTest(root: HTMLElement, query: string, occurrence = 0) {
  const blocks = indexText(root, query);
  const ranges = blocks.flatMap((block) =>
    block.offsets.map((_, index) => setMatch(new Range(), block, index, query.length)),
  );
  return {
    ranges,
    selected: ranges[occurrence] ?? ranges[0],
  };
}

interface Layout {
  readonly box: Element;
  readonly separateItems: boolean;
  readonly hidden: boolean;
  readonly ordered: boolean;
}

interface PaintRun {
  readonly block: TextBlock;
  readonly layout: Layout;
  readonly start: number;
  end: number;
  painted: Map<number, Range>;
}

function layoutRuns(root: HTMLElement, blocks: readonly TextBlock[]): PaintRun[] {
  const layouts = new Map<Element, Layout>();
  const layoutOf = (element: Element): Layout => {
    const cached = layouts.get(element);
    if (cached) return cached;
    const parent = element === root ? undefined : layoutOf(element.parentElement!);
    const style = getComputedStyle(element);
    const inline = style.display === "inline" || style.display === "contents";
    const layout = {
      box: inline && parent ? parent.box : element,
      separateItems: inline && parent ? parent.separateItems : /flex|grid/.test(style.display),
      hidden: style.display === "none" || parent?.hidden === true,
      ordered:
        parent?.ordered !== false && style.columnCount === "auto" && style.columnWidth === "auto",
    };
    layouts.set(element, layout);
    return layout;
  };
  const runs: PaintRun[] = [];
  for (const block of blocks) {
    let start = 0;
    for (const [index, { node }] of block.nodes.entries()) {
      const next = block.nodes[index + 1];
      const end = next
        ? firstIndex(start, block.offsets.length, (i) => block.offsets[i]! >= next.start)
        : block.offsets.length;
      if (start === end) continue;
      const layout = layoutOf(node.parentElement!);
      const previous = runs.at(-1);
      // A block can contain independent formatting contexts, such as flex items.
      if (
        previous?.block === block &&
        !layout.separateItems &&
        previous.layout.box === layout.box &&
        previous.layout.hidden === layout.hidden &&
        previous.layout.ordered === layout.ordered
      ) {
        previous.end = end;
      } else {
        runs.push({ block, layout, start, end, painted: new Map() });
      }
      start = end;
    }
  }
  return runs;
}

interface VerticalZone {
  readonly top: number;
  readonly bottom: number;
}

function intersects(rect: DOMRect, zone: VerticalZone): boolean {
  return rect.height > 0 && rect.bottom >= zone.top && rect.top <= zone.bottom;
}

function firstRenderedMatch(
  start: number,
  end: number,
  measure: (index: number) => DOMRect,
  predicate: (rect: DOMRect) => boolean,
): number {
  while (start < end) {
    const mid = (start + end) >>> 1;
    // Collapsed whitespace can leave gaps in the sequence of laid-out matches.
    let probe = mid;
    let rect = measure(probe);
    while (rect.height === 0 && ++probe < end) rect = measure(probe);
    if (probe === end || predicate(rect)) end = mid;
    else start = probe + 1;
  }
  return start;
}

function placeRun(
  run: PaintRun,
  zone: VerticalZone | null,
  length: number,
  scratch: Range,
  highlight: Highlight,
  selected: Match | null,
) {
  const { block, layout } = run;
  if ((!zone || layout.hidden) && run.painted.size === 0) return;
  const next = new Map<number, Range>();
  if (zone && !layout.hidden && intersects(layout.box.getBoundingClientRect(), zone)) {
    const clip = layout.box.closest<HTMLElement>('[data-folded="true"]')?.querySelector("pre");
    const clipRect = clip?.getBoundingClientRect();
    const top = Math.max(zone.top, clipRect?.top ?? zone.top);
    const bottom = Math.min(zone.bottom, clipRect?.bottom ?? zone.bottom);
    const measure = (index: number) =>
      setMatch(scratch, block, index, length).getBoundingClientRect();
    const add = (index: number) => {
      if (selected?.block === block && selected.index === index) return;
      const previous = run.painted.get(index);
      const range = previous ?? setMatch(new Range(), block, index, length);
      next.set(index, range);
      if (!previous) highlight.add(range);
    };
    if (top <= bottom) {
      if (layout.ordered) {
        // In one inline formatting context, line positions follow document order.
        const start = firstRenderedMatch(run.start, run.end, measure, (rect) => rect.bottom >= top);
        const end = firstRenderedMatch(start, run.end, measure, (rect) => rect.top > bottom);
        for (let i = start; i < end; i++) add(i);
      } else {
        for (let i = run.start; i < run.end; i++)
          if (intersects(measure(i), { top, bottom })) add(i);
      }
    }
  }
  for (const [index, range] of run.painted) if (!next.has(index)) highlight.delete(range);
  run.painted = next;
}

interface Selection {
  readonly entryId: string;
  readonly occurrence: number;
  readonly requestId?: number | null;
  readonly onSelectedRange?: ((requestId: number, range: Range) => void) | undefined;
}

interface SearchEntry {
  readonly blocks: TextBlock[];
  runs: PaintRun[] | null;
}

export function watchThreadFindHighlights(
  container: HTMLElement,
  query: string,
  readSelection: () => Selection | null,
) {
  const registry = typeof Highlight === "undefined" ? undefined : CSS.highlights;
  const inactive = registry ? new Highlight() : null;
  const active = registry ? new Highlight() : null;
  if (registry && inactive && active) {
    registry.set(MATCHES, inactive);
    registry.set(ACTIVE, active);
  }
  const scratch = new Range();
  // Keep offsets for every rendered match, but allocate live ranges only for the
  // viewport window and the active match. Blink rebuilds registered highlights
  // during layout, so a large registry would make unrelated DOM updates costly.
  const entries = new Map<HTMLElement, SearchEntry>();
  let roots: HTMLElement[] = [];
  let refreshRoots = true;
  let frame = 0;
  let reported: number | null = null;
  let previousBlocks: TextBlock[] | undefined;
  let previousOccurrence: number | undefined;
  let selected: Match | null = null;
  let exact = false;

  const clearRuns = (entry: SearchEntry) => {
    for (const run of entry.runs ?? [])
      for (const range of run.painted.values()) inactive?.delete(range);
    entry.runs = null;
  };
  const paint = () => {
    frame = 0;
    if (refreshRoots) {
      roots = [...container.querySelectorAll<HTMLElement>(BODY)];
      const mounted = new Set(roots);
      for (const [root, entry] of entries) {
        if (mounted.has(root)) continue;
        clearRuns(entry);
        entries.delete(root);
      }
      refreshRoots = false;
    }
    const viewport = container.getBoundingClientRect();
    const zone = { top: viewport.top - viewport.height, bottom: viewport.bottom + viewport.height };
    const selection = readSelection();
    let selectedBlocks: TextBlock[] | undefined;
    for (const root of roots) {
      const isSelected =
        root.closest(ROW)?.getAttribute("data-timeline-row-id") === selection?.entryId;
      const near = intersects(root.getBoundingClientRect(), zone);
      let entry = entries.get(root);
      if (!entry && (near || isSelected)) {
        entry = { blocks: indexText(root, query), runs: null };
        entries.set(root, entry);
      }
      if (!entry) continue;
      if (isSelected && selection) {
        selectedBlocks = entry.blocks;
        if (selectedBlocks !== previousBlocks || selection.occurrence !== previousOccurrence) {
          const match = findOccurrence(selectedBlocks, selection.occurrence, query.length);
          exact = match !== null;
          selected = match ?? findOccurrence(selectedBlocks, 0, query.length);
          active?.clear();
          if (selected) active?.add(selected.range);
        }
      }
      if (!inactive || (!near && !entry.runs)) continue;
      if (near) entry.runs ??= layoutRuns(root, entry.blocks);
      for (const run of entry.runs ?? []) {
        placeRun(
          run,
          near ? zone : null,
          query.length,
          scratch,
          inactive,
          isSelected ? selected : null,
        );
      }
    }
    previousBlocks = selectedBlocks;
    previousOccurrence = selection?.occurrence;
    if (!selectedBlocks && selected) {
      selected = null;
      active?.clear();
    }
    // An earlier rendered match can stand in visually while the requested one
    // mounts, but must never claim the navigation request.
    if (exact && selected && selection?.requestId != null && reported !== selection.requestId) {
      reported = selection.requestId;
      selection.onSelectedRange?.(reported, selected.range);
    }
  };
  const refresh = () => {
    if (!frame) frame = requestAnimationFrame(paint);
  };
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      const target =
        mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
      if (!target || (mutation.type !== "attributes" && target.closest(IGNORE))) continue;
      const root = target.closest<HTMLElement>(BODY);
      if (root) {
        const entry = entries.get(root);
        if (entry) {
          clearRuns(entry);
          entries.delete(root);
        }
      } else if (
        mutation.type === "childList" &&
        [...mutation.addedNodes, ...mutation.removedNodes].some(
          (node) => node instanceof Element && (node.matches(BODY) || node.querySelector(BODY)),
        )
      ) {
        refreshRoots = true;
      } else if (mutation.type === "attributes") {
        for (const [body, entry] of entries) if (target.contains(body)) clearRuns(entry);
      } else {
        continue;
      }
      if (mutation.attributeName === "data-thread-find-text") refreshRoots = true;
      refresh();
    }
  });
  observer.observe(container, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      "hidden",
      "data-folded",
      "data-word-wrap",
      "data-thread-find-text",
      "data-thread-find-ignore",
      "data-timeline-row-id",
      "aria-hidden",
    ],
  });
  container.addEventListener("scroll", refresh, { passive: true });
  const stopResize = observeResize(container, refresh);
  refresh();
  return {
    refresh,
    clear: () => {
      observer.disconnect();
      stopResize();
      container.removeEventListener("scroll", refresh);
      cancelAnimationFrame(frame);
      if (registry) {
        if (registry.get(MATCHES) === inactive) registry.delete(MATCHES);
        if (registry.get(ACTIVE) === active) registry.delete(ACTIVE);
      }
    },
  };
}
