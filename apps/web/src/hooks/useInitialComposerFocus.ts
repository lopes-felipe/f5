import { useEffect } from "react";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { hasVisibleFocusPopup } from "../lib/keyboardFocus";

/** Offer initial focus after the thread's composer mounts. */
export function useInitialComposerFocus(
  threadId: string | undefined,
  terminalOpen: boolean,
  focusComposer: () => void,
): void {
  useEffect(() => {
    if (!threadId || terminalOpen) return;
    const frame = window.requestAnimationFrame(() => {
      // Hydration may finish after the user has started editing or opened a
      // popup. Check at execution time; never move an existing caret to the end.
      const active = document.activeElement;
      if (
        (active && active !== document.body && active !== document.documentElement) ||
        useCommandPaletteStore.getState().open ||
        hasVisibleFocusPopup() ||
        window.getSelection()?.toString()
      )
        return;
      focusComposer();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [threadId, focusComposer, terminalOpen]);
}
