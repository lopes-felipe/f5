import type { ShortcutEventLike } from "../keybindings";
import { useCommandPaletteStore } from "../commandPaletteStore";

const CLOSED_FOCUS_SURFACE =
  '[data-closed],[data-ending-style],[data-state="closed"],[aria-hidden="true"],[hidden],[inert]';

/** Popups own initial focus even before their input has received it. */
export function hasVisibleFocusPopup(): boolean {
  return [
    ...document.querySelectorAll<HTMLElement>(
      '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[data-slot="popover-popup"],[aria-haspopup]:not([aria-haspopup="false"])[aria-expanded="true"]',
    ),
  ].some(
    (element) =>
      !element.closest(CLOSED_FOCUS_SURFACE) &&
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== "hidden",
  );
}

/** Passive focus may leave navigation controls, but never interrupt editing. */
export function shouldOfferComposerFocus(): boolean {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  const editing =
    active instanceof HTMLElement &&
    (active.isContentEditable || active.matches("input,textarea,select,iframe")) &&
    !active.closest(CLOSED_FOCUS_SURFACE);
  return (
    !document.hidden &&
    !editing &&
    !useCommandPaletteStore.getState().open &&
    !hasVisibleFocusPopup() &&
    !window.getSelection()?.toString()
  );
}

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

/** Keep typing, editing and find navigation in CodeView; modified app
 * navigation (panel toggles, thread switching, palette) still belongs to F5. */
export function isDiffSearchEditingKey(event: ShortcutEventLike): boolean {
  if (!isDiffSearchInputFocused(event)) return false;
  if (!event.metaKey && !event.ctrlKey && !event.altKey) return true;
  if (event.altKey && (event.metaKey || event.ctrlKey)) return false;
  const key = event.key.toLowerCase();
  return (
    [
      "arrowleft",
      "arrowright",
      "arrowup",
      "arrowdown",
      "home",
      "end",
      "backspace",
      "delete",
    ].includes(key) ||
    (!event.altKey &&
      (event.metaKey || event.ctrlKey) &&
      ["a", "c", "v", "x", "z", "y", "f", "g"].includes(key))
  );
}
