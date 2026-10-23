import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";
import { resolveShortcutCommand, useServerKeybindings } from "~/keybindings";
import { setSearchParamsForSurface } from "~/rightPanelNavigation";
import { useRightPanelStore } from "~/rightPanelStore";
import { canUndoThreadAction, undoThreadAction } from "~/threadUndo";

export function ThreadNavigationController() {
  const router = useRouter();
  const keybindings = useServerKeybindings();
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const target = event.target instanceof Element ? event.target : null;
      const editableFocus = Boolean(target?.closest("input, textarea, [contenteditable=true]"));
      const terminalFocus = Boolean(target?.closest(".xterm"));
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          editableFocus,
          terminalFocus,
          dialogFocus: Boolean(document.querySelector('[role="dialog"], [role="alertdialog"]')),
          threadUndoAvailable: canUndoThreadAction(),
        },
      });
      if (command === "thread.undo" && !editableFocus) {
        event.preventDefault();
        void undoThreadAction();
      } else if (command === "navigation.back") {
        event.preventDefault();
        router.history.back();
      } else if (command === "navigation.forward") {
        event.preventDefault();
        router.history.forward();
      } else if (command === "rightPanel.reopenClosed") {
        event.preventDefault();
        // History is app-wide, so this also returns to the tab's thread from
        // another thread or from Settings.
        const reopened = useRightPanelStore.getState().reopenClosed();
        if (!reopened) return;
        const sameThread = router.state.location.pathname === `/${reopened.threadId}`;
        void router.navigate({
          to: "/$threadId",
          params: { threadId: reopened.threadId },
          replace: sameThread,
          search: (previous: Record<string, unknown>) =>
            setSearchParamsForSurface(sameThread ? previous : {}, reopened.surface),
        });
      }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [keybindings, router]);
  return null;
}
