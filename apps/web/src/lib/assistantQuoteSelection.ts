const ASSISTANT_MESSAGE = '[data-message-role="assistant"][data-message-id]';

function selectedTextBoundary(range: Range, node: Node, last: boolean): Text | null {
  if (!range.intersectsNode(node)) return null;
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node as Text;
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : text.length;
    const element = text.parentElement;
    const view = element?.ownerDocument.defaultView;
    return start < end && element && view?.getComputedStyle(element).userSelect !== "none"
      ? text
      : null;
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
  const text = range.toString().trim();
  if (!text) return null;
  return { source, range, text: text.slice(0, 4000) };
}
