import { useEffect, useRef } from "react";
import { useRouter } from "@tanstack/react-router";
import { resolveShortcutCommand, useServerKeybindings } from "~/keybindings";
import { navigateHistory } from "~/navigationHistory";
import { setSearchParamsForSurface } from "~/rightPanelNavigation";
import { useRightPanelStore } from "~/rightPanelStore";
import {
  canUndoThreadAction,
  releaseThreadUndoShortcut,
  threadUndoClaimsShortcut,
  undoThreadAction,
} from "~/threadUndo";

const MODIFIER_KEYS = new Set(["Alt", "Control", "Meta", "Shift"]);
// Toasts, including the undo notice itself, are non-modal dialogs and must not block shortcuts.
const MODAL_DIALOG_SELECTOR =
  '[role="dialog"]:not([aria-modal="false"]), [role="alertdialog"]:not([aria-modal="false"])';

function shortcutTargetContext(event: KeyboardEvent) {
  const target = event.target instanceof Element ? event.target : null;
  return {
    editableFocus: Boolean(target?.closest("input, textarea, [contenteditable=true]")),
    terminalFocus: Boolean(target?.closest(".xterm")),
    dialogFocus: Boolean(
      target?.closest(MODAL_DIALOG_SELECTOR) ?? document.querySelector(MODAL_DIALOG_SELECTOR),
    ),
  };
}

export function ThreadNavigationController() {
  const router = useRouter();
  const keybindings = useServerKeybindings();
  // Outlives the effect, so a held key stays claimed if keybindings change mid-hold.
  const heldUndoKey = useRef<string | null>(null);

  // Capture phase, so mod+z reaches thread undo before the composer's own undo
  // handler consumes it while a fresh undo notice claims the shortcut.
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      // A held key undoes once. Cancel its repeats so they cannot fall through
      // to the editor's own undo, even after the last action is undone.
      if (event.repeat) {
        if (event.code === heldUndoKey.current) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      // A modifier tapped mid-hold leaves the held key repeating.
      if (!MODIFIER_KEYS.has(event.key)) heldUndoKey.current = null;
      if (event.defaultPrevented || event.isComposing) return;
      const context = shortcutTargetContext(event);
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          ...context,
          // A terminal keeps its own Ctrl+Z (suspend) even while a fresh undo claims the key.
          editableFocus:
            context.editableFocus && (context.terminalFocus || !threadUndoClaimsShortcut()),
          threadUndoAvailable: canUndoThreadAction(),
        },
      });
      if (command !== "thread.undo") {
        if (!MODIFIER_KEYS.has(event.key)) releaseThreadUndoShortcut();
        return;
      }
      heldUndoKey.current = event.code;
      event.preventDefault();
      event.stopPropagation();
      void undoThreadAction();
    };
    // Pastes from a menu, dictation and drops edit text without a keypress.
    const onInput = () => releaseThreadUndoShortcut();
    window.addEventListener("keydown", handle, true);
    window.addEventListener("input", onInput, true);
    return () => {
      window.removeEventListener("keydown", handle, true);
      window.removeEventListener("input", onInput, true);
    };
  }, [keybindings]);

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: { ...shortcutTargetContext(event), threadUndoAvailable: canUndoThreadAction() },
      });
      if (command === "navigation.back") {
        event.preventDefault();
        navigateHistory(router.history, "back");
      } else if (command === "navigation.forward") {
        event.preventDefault();
        navigateHistory(router.history, "forward");
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
