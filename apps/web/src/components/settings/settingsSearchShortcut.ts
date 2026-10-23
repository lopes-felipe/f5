export type SettingsSearchShortcut = "find" | "slash";

type ShortcutKeyEvent = Pick<
  KeyboardEvent,
  "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing" | "defaultPrevented"
>;

/**
 * Cmd/Ctrl+F focuses settings search from anywhere, including text fields, the way find
 * works on a page. Plain `/` only applies outside text fields, where it would otherwise type.
 */
export function resolveSettingsSearchShortcut(
  event: ShortcutKeyEvent,
): SettingsSearchShortcut | null {
  if (event.defaultPrevented || event.isComposing) return null;
  if (
    event.key.toLowerCase() === "f" &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey
  ) {
    return "find";
  }
  if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey) return "slash";
  return null;
}
