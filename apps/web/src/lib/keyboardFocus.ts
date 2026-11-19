import type { ShortcutEventLike } from "../keybindings";

export function isEventInFindScope(event: ShortcutEventLike, scope: "diff" | "preview"): boolean {
  if (typeof document === "undefined" || typeof Element === "undefined") return false;
  const selector = '[data-find-scope="' + scope + '"]';
  const path =
    "composedPath" in event && typeof event.composedPath === "function"
      ? (event.composedPath() as EventTarget[])
      : [];
  const elements = path.filter((node): node is Element => node instanceof Element);
  if (elements.length > 0) return elements.some((node) => node.closest(selector) !== null);
  return (
    document.activeElement instanceof Element && document.activeElement.closest(selector) !== null
  );
}

/** Shadow inputs retarget keyboard events to their host at the window listener. */
export function isDiffSearchInputFocused(event: ShortcutEventLike): boolean {
  if (!isEventInFindScope(event, "diff")) return false;
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return (
    active instanceof HTMLElement &&
    (active.matches("input, textarea, select") || active.isContentEditable)
  );
}
