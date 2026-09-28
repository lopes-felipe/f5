/** Clipboard keys must leave Ctrl+C available to the shell when nothing is selected. */
export function terminalClipboardAction(
  event: Pick<KeyboardEvent, "type" | "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">,
  hasSelection: boolean,
): "copy" | "paste" | null {
  if (event.type !== "keydown" || event.altKey || event.metaKey) return null;
  if (
    event.ctrlKey &&
    !event.shiftKey &&
    hasSelection &&
    (event.key.toLowerCase() === "c" || event.key === "Insert")
  )
    return "copy";
  if (event.shiftKey && !event.ctrlKey && event.key === "Insert") return "paste";
  return null;
}
