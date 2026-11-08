const ASSISTANT_MESSAGE = '[data-message-role="assistant"][data-message-id]';
const EXCLUDED =
  '[data-assistant-quote-exclude], .sr-only, [hidden], [aria-hidden="true"], button, input, textarea, select, script, style';

function excluded(element: Element): boolean {
  if (element.closest(EXCLUDED)) return true;
  const view = element.ownerDocument.defaultView;
  for (let current: Element | null = element; current; current = current.parentElement) {
    const style = view?.getComputedStyle(current);
    if (
      style?.display === "none" ||
      style?.visibility === "hidden" ||
      style?.userSelect === "none"
    ) {
      return true;
    }
  }
  return false;
}

function selectedTextBoundary(range: Range, node: Node, last: boolean): Text | null {
  if (!range.intersectsNode(node)) return null;
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node as Text;
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : text.length;
    const element = text.parentElement;
    return start < end && element && !excluded(element) ? text : null;
  }
  for (
    let child = last ? node.lastChild : node.firstChild;
    child !== null;
    child = last ? child.previousSibling : child.nextSibling
  ) {
    const boundary = selectedTextBoundary(range, child, last);
    if (boundary) return boundary;
  }
  return null;
}

/** Read selected display text without changing the native selection or including row metadata. */
function readQuoteText(source: Element, range: Range): string {
  let result = "";
  let pendingBreaks = 0;
  const separate = (count: number) => {
    pendingBreaks = Math.max(pendingBreaks, count);
  };
  const visit = (node: Node) => {
    if (!range.intersectsNode(node)) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node as Text;
      const start = node === range.startContainer ? range.startOffset : 0;
      const end = node === range.endContainer ? range.endOffset : text.length;
      let value = text.data.slice(start, end);
      if (!value) return;
      const style = source.ownerDocument.defaultView?.getComputedStyle(text.parentElement!);
      if (!style?.whiteSpace.startsWith("pre") && style?.whiteSpace !== "break-spaces") {
        value = value.replace(/\s+/g, " ");
        if (!value.trim() && pendingBreaks) return;
      }
      if (result && pendingBreaks) result = result.trimEnd() + "\n".repeat(pendingBreaks);
      pendingBreaks = 0;
      result += value;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    if (excluded(element)) return;
    if (element.tagName === "BR") {
      result += "\n";
      return;
    }
    const display = source.ownerDocument.defaultView?.getComputedStyle(element).display;
    const breaks =
      element.tagName === "P" ? 2 : display === "block" || display === "list-item" ? 1 : 0;
    separate(breaks);
    for (const child of element.childNodes) visit(child);
    separate(breaks);
  };
  visit(source);
  return result.trim();
}

/** Native paragraph selections can end past unselectable rows at the next paragraph's start. */
export function captureAssistantQuoteSelection(selection: Selection | null) {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0).cloneRange();
  const first = selectedTextBoundary(range, range.commonAncestorContainer, false);
  const last = selectedTextBoundary(range, range.commonAncestorContainer, true);
  const source = first?.parentElement?.closest(ASSISTANT_MESSAGE);
  if (!first || !last || !source || source !== last.parentElement?.closest(ASSISTANT_MESSAGE)) {
    return null;
  }
  // Validate the text actually selected, rather than empty or unselectable endpoints.
  range.setStart(first, first === range.startContainer ? range.startOffset : 0);
  range.setEnd(last, last === range.endContainer ? range.endOffset : last.length);
  const text = readQuoteText(source, range);
  if (!text) return null;
  return { source, range, text: text.slice(0, 4000) };
}
