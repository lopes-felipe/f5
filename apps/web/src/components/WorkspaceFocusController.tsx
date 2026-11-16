import { useEffect } from "react";

import { resolveShortcutCommand, useServerKeybindings } from "~/keybindings";
import { moveWorkspaceFocus, startWorkspaceFocus } from "~/lib/workspaceFocus";

/** Desktop menu actions a focused preview guest forwards for F6 and Shift+F6. */
export const WORKSPACE_FOCUS_MENU_ACTIONS = {
  "workspace.focusNext": 1,
  "workspace.focusPrevious": -1,
} as const;

/** F6 and Shift+F6 move focus between the sidebar, conversation, composer and panels. */
export function WorkspaceFocusController() {
  const keybindings = useServerKeybindings();
  useEffect(() => startWorkspaceFocus(document), []);

  // Capture phase, so F6 also leaves widgets that swallow keys, such as the terminal.
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const command = resolveShortcutCommand(event, keybindings);
      if (command !== "workspace.focusNext" && command !== "workspace.focusPrevious") return;
      // Inside a dialog the move is refused, but the key is still consumed.
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) moveWorkspaceFocus(WORKSPACE_FOCUS_MENU_ACTIONS[command]);
    };
    window.addEventListener("keydown", handle, true);
    return () => window.removeEventListener("keydown", handle, true);
  }, [keybindings]);

  // A focused preview keeps the keyboard, so the desktop app forwards the key. The
  // renderer's own focus is stale then; the move starts from the panel holding the preview.
  useEffect(
    () =>
      window.desktopBridge?.onMenuAction?.((action) => {
        if (action === "workspace.focusNext" || action === "workspace.focusPrevious")
          moveWorkspaceFocus(WORKSPACE_FOCUS_MENU_ACTIONS[action], "panel");
      }),
    [],
  );
  return null;
}
