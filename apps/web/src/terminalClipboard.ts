/** Clipboard keys must leave Ctrl+C available to the shell when nothing is selected. */
export function terminalClipboardAction(
  event: Pick<
    KeyboardEvent,
    "type" | "key" | "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey"
  >,
  hasSelection: boolean,
  platform: string,
): "copy" | "paste" | null {
  if (/mac/i.test(platform)) return null;
  if (event.type !== "keydown" || event.altKey || event.metaKey) return null;
  if (
    event.ctrlKey &&
    !event.shiftKey &&
    hasSelection &&
    (event.code === "KeyC" || event.key.toLowerCase() === "c" || event.key === "Insert")
  )
    return "copy";
  if (event.shiftKey && !event.ctrlKey && event.key === "Insert") return "paste";
  return null;
}

export function terminalRightClickPastes(platform: string): boolean {
  return /win|linux/i.test(platform);
}
