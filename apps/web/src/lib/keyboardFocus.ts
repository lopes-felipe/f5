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
function isDiffSearchInputFocused(event: ShortcutEventLike): boolean {
  if (!isEventInFindScope(event, "diff")) return false;
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return (
    active instanceof HTMLElement &&
    (active.matches("input, textarea, select") || active.isContentEditable)
  );
}

const FIELD_NAVIGATION_KEYS = new Set([
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "Backspace",
  "Delete",
  "End",
  "Home",
]);

export function isDiffSearchEditingKey(event: ShortcutEventLike): boolean {
  if (!isDiffSearchInputFocused(event)) return false;
  if (FIELD_NAVIGATION_KEYS.has(event.key)) return true;
  if (event.key === "Enter" || event.key === "Escape" || event.key === "F3") {
    return !event.ctrlKey && !event.metaKey && !event.altKey;
  }
  if (event.ctrlKey || event.metaKey) {
    if (
      "getModifierState" in event &&
      typeof event.getModifierState === "function" &&
      event.getModifierState("AltGraph")
    )
      return event.key.length === 1;
    return !event.altKey && /^[acfvxyz]$/i.test(event.key);
  }
  return !event.altKey && ([...event.key].length === 1 || event.key === "Dead");
}
