import { findThreadSearchOccurrences } from "@t3tools/shared/threadSearch";

const blocks = new Set([
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
/** Inline syntax spans stay contiguous; distinct Markdown blocks never join. */
export function threadFindRanges(root: HTMLElement, query: string, occurrence = 0) {
  const ranges: Range[] = [];
  let selected: Range | undefined;
  let count = 0;
  let nodes: Text[] = [];
  const flush = () => {
    const text = nodes.map((node) => node.data).join("");
    for (const offset of findThreadSearchOccurrences(text, query)) {
      const index = count++;
      if (ranges.length >= 2_000 && index !== occurrence) continue;
      let position = 0;
      const range = document.createRange();
      for (const node of nodes) {
        const end = position + node.length;
        if (position <= offset && offset < end) range.setStart(node, offset - position);
        if (position < offset + query.length && offset + query.length <= end) {
          range.setEnd(node, offset + query.length - position);
          break;
        }
        position = end;
      }
      if (index === occurrence) selected = range;
      if (ranges.length < 2_000) ranges.push(range);
    }
    nodes = [];
  };
  const visit = (node: Node) => {
    if (node instanceof Text) {
      nodes.push(node);
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (
      node.matches(
        'button,input,textarea,select,script,style,.sr-only,[aria-hidden="true"],[data-thread-find-ignore]',
      )
    ) {
      flush();
      return;
    }
    const block = blocks.has(node.tagName);
    if (block) flush();
    for (const child of node.childNodes) visit(child);
    if (block) flush();
  };
  visit(root);
  flush();
  return { ranges, selected: selected ?? ranges[0] };
}

export function highlightThreadFind(root: HTMLElement, query: string, occurrence: number) {
  const { ranges, selected } = threadFindRanges(root, query, occurrence);
  const matches = typeof Highlight !== "undefined" ? new Highlight(...ranges) : undefined;
  const active =
    typeof Highlight !== "undefined" ? new Highlight(...(selected ? [selected] : [])) : undefined;
  if (typeof Highlight !== "undefined" && CSS.highlights) {
    CSS.highlights.set("f5-thread-find", matches!);
    CSS.highlights.set("f5-thread-find-active", active!);
  }
  if (selected) {
    const container = root.closest<HTMLElement>('[data-slot="messages-scroll-container"]');
    const rect = selected.getBoundingClientRect();
    if (container && rect.height)
      container.scrollBy({
        top: rect.top - container.getBoundingClientRect().top - container.clientHeight * 0.3,
        behavior: "instant",
      });
  }
  return () => {
    if (typeof CSS !== "undefined" && CSS.highlights) {
      if (CSS.highlights.get("f5-thread-find") === matches) CSS.highlights.delete("f5-thread-find");
      if (CSS.highlights.get("f5-thread-find-active") === active)
        CSS.highlights.delete("f5-thread-find-active");
    }
  };
}
