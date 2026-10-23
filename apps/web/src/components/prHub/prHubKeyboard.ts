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
/** Cmd/Ctrl+Enter in a PR composer runs its primary action, unless an IME is composing. */
export function isPrSubmitShortcut(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat: boolean;
  keyCode: number;
  nativeEvent: { isComposing: boolean };
}): boolean {
  if (event.nativeEvent.isComposing || event.keyCode === 229) return false;
  return (
    event.key === "Enter" &&
    (event.metaKey || event.ctrlKey) &&
    !event.shiftKey &&
    !event.altKey &&
    !event.repeat
  );
}

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
