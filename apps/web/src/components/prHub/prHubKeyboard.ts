/**
 * True when focus is somewhere that should swallow single-key shortcuts — a
 * text field, a contenteditable region, or an open dialog/menu/combobox whose
 * own keyboard handling must win. Both mode views consult this before acting on
 * local hotkeys so typing in a dialog never triggers navigation.
 *
 * Note: this deliberately does NOT match `role="listbox"`. The Inbox spine is a
 * listbox of focusable `role="option"` buttons whose navigation is handled at
 * the window level (it has no built-in key handling), so matching listbox here
 * would suppress the very handler we want to run after clicking a row.
 */
export function isInteractiveTextTarget(): boolean {
  const element = document.activeElement as HTMLElement | null;
  if (!element) return false;
  const tag = element.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (element.isContentEditable) return true;
  if (element.closest('[role="dialog"], [role="menu"], [role="combobox"]')) {
    return true;
  }
  return false;
}
